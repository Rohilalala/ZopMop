package matching

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
)

// Batcher collects incoming instant-booking requests and processes them
// together every `interval` seconds, mirroring Uber's batch-matching window.
//
// Why batch?  If ten customers in the same neighbourhood request a service
// within a 5-second window, processing them independently would cause the
// algorithm to greedily assign the best helper to the first request, leaving
// the remaining nine with successively worse options.  By waiting briefly and
// solving all requests together (GreedyAssign), the engine minimises total
// wait time across the batch rather than just optimising for request #1.
//
// Only instant bookings go through the batcher.  Scheduled bookings (with a
// chosen time slot) are matched by a separate pre-dispatch job closer to their
// scheduled_time and are never enqueued here.
type Batcher struct {
	engine   *Engine
	interval time.Duration

	mu    sync.Mutex
	queue []BatchEntry // guarded by mu

	in   chan BatchEntry
	stop chan struct{}
	done chan struct{}
}

// NewBatcher creates a Batcher backed by the given engine.
// Call Start() to begin processing; call Stop() for graceful shutdown.
func NewBatcher(engine *Engine, interval time.Duration) *Batcher {
	return &Batcher{
		engine:   engine,
		interval: interval,
		in:       make(chan BatchEntry, 512),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
}

// Enqueue adds an instant booking to the next batch window.
// Non-blocking: if the internal buffer is full (>512 pending), the entry is
// dropped and an error is logged — the booking still exists in Postgres as
// 'pending' and can be retried via the slow-path fallback in FindBestHelpers.
func (b *Batcher) Enqueue(entry BatchEntry) {
	select {
	case b.in <- entry:
	default:
		log.Warn().
			Str("booking_id", entry.BookingID).
			Msg("[batcher] queue full — booking will rely on fallback matching")
	}
}

// Start runs the batch-matching loop in a background goroutine.
// It must be called exactly once before any Enqueue calls.
func (b *Batcher) Start() {
	go b.run()
}

// Stop signals the loop to finish its current batch and exit cleanly.
// Blocks until the goroutine has exited.
func (b *Batcher) Stop() {
	close(b.stop)
	<-b.done
}

// ── internal loop ─────────────────────────────────────────────────────────────

func (b *Batcher) run() {
	defer close(b.done)

	ticker := time.NewTicker(b.interval)
	defer ticker.Stop()

	for {
		select {
		case entry := <-b.in:
			b.mu.Lock()
			b.queue = append(b.queue, entry)
			b.mu.Unlock()

		case <-ticker.C:
			b.processBatch()

		case <-b.stop:
			// Drain any entries that arrived just before shutdown.
		drainLoop:
			for {
				select {
				case entry := <-b.in:
					b.mu.Lock()
					b.queue = append(b.queue, entry)
					b.mu.Unlock()
				default:
					break drainLoop
				}
			}
			b.processBatch()
			return
		}
	}
}

func (b *Batcher) processBatch() {
	b.mu.Lock()
	batch := b.queue
	b.queue = nil
	b.mu.Unlock()

	// Also scan DB for unmatched pending bookings — handles retries and server restarts.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if dbEntries, err := b.engine.FetchPendingUnmatched(ctx); err != nil {
		log.Warn().Err(err).Msg("[batcher] failed to scan pending bookings from DB")
	} else if len(dbEntries) > 0 {
		seen := make(map[string]struct{}, len(batch))
		for _, e := range batch {
			seen[e.BookingID] = struct{}{}
		}
		for _, e := range dbEntries {
			if _, dup := seen[e.BookingID]; !dup {
				batch = append(batch, e)
			}
		}
	}

	if len(batch) == 0 {
		return
	}

	log.Info().Int("bookings", len(batch)).Msg("[batcher] processing batch")

	// Score all candidates for every booking in the batch.
	cfg := b.engine.getConfig(ctx)
	candidatesByBooking := make(map[string][]HelperCandidate, len(batch))
	for _, entry := range batch {
		candidates, err := b.engine.fetchAndScoreCandidates(ctx, entry.Lat, entry.Lng)
		if err != nil {
			log.Warn().Err(err).
				Str("booking_id", entry.BookingID).
				Msg("[batcher] failed to fetch candidates")
			continue
		}
		candidates = b.engine.filterByWalkingTime(ctx, candidates, entry.Lat, entry.Lng, cfg.MaxWalkMinutes)
		candidatesByBooking[entry.BookingID] = candidates
	}

	// Dynamic cap: keep every walk-eligible pro per booking. As pros reject
	// or their per-pro invite expires, the chain (matchHelperKeyFmt set) falls
	// through to the next ranked pro automatically rather than dead-ending at
	// a fixed top-N. Zero = no cap inside ToHelperMatches.
	assignments := GreedyAssign(batch, candidatesByBooking, 0)

	// Persist assignments to Redis and update match_attempts in Postgres.
	for bookingID, matches := range assignments {
		if err := b.engine.storeMatchResults(ctx, bookingID, matches); err != nil {
			log.Error().Err(err).
				Str("booking_id", bookingID).
				Msg("[batcher] failed to store match results")
		}
	}

	log.Info().
		Int("bookings", len(batch)).
		Int("matched", len(assignments)).
		Msg("[batcher] batch complete")
}
