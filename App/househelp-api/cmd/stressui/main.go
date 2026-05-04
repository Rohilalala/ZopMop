// stressui — browser dashboard for the stress-test suite. Serves an
// embedded HTML page on :8090, spawns the tagged stresstest binaries (or k6)
// in response to button clicks, and streams subprocess stdout+stderr over
// Server-Sent Events so the browser can tail the run live. Reads the latest
// verify JSON + k6 summary JSON from disk for the dashboard cards.
//
// Run from the househelp-api directory so relative paths resolve:
//     DATABASE_URL=... REDIS_URL=... JWT_SECRET=... go run ./cmd/stressui
//
// Then open http://localhost:8090 in a browser.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed static/*
var staticFS embed.FS

const (
	defaultAddr     = ":8090"
	maxLogLines     = 2000
	jobReaperAfter  = 30 * time.Minute
	resultsDir      = "loadtest/results"
	verifyReportGlob = "stress_report_*.json"
	k6SummaryGlob    = "k6_summary_*.json"
)

type logEntry struct {
	TS   time.Time `json:"ts"`
	Line string    `json:"line"`
	// Stream is "stdout", "stderr", or "system".
	Stream string `json:"stream"`
}

type job struct {
	ID        string      `json:"id"`
	Action    string      `json:"action"`
	StartedAt time.Time   `json:"started_at"`
	EndedAt   *time.Time  `json:"ended_at,omitempty"`
	ExitCode  *int        `json:"exit_code,omitempty"`
	Status    string      `json:"status"` // running|done|error

	mu       sync.Mutex
	logs     []logEntry
	subs     map[chan logEntry]struct{}
	done     chan struct{}
	cmd      *exec.Cmd
}

type server struct {
	mu   sync.Mutex
	jobs map[string]*job
	root string
}

func main() {
	addr := envOrDefault("STRESSUI_ADDR", defaultAddr)
	requireEnv("DATABASE_URL")
	requireEnv("REDIS_URL")
	requireEnv("JWT_SECRET")

	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "stressui: getcwd: %v\n", err)
		os.Exit(1)
	}
	if _, err := os.Stat(filepath.Join(root, "cmd", "stresstest")); err != nil {
		fmt.Fprintf(os.Stderr, "stressui: must be run from the househelp-api directory (cmd/stresstest not found): %v\n", err)
		os.Exit(2)
	}
	if err := os.MkdirAll(filepath.Join(root, resultsDir), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "stressui: mkdir %s: %v\n", resultsDir, err)
		os.Exit(1)
	}

	s := &server{
		jobs: map[string]*job{},
		root: root,
	}
	go s.reapJobs()

	mux := http.NewServeMux()

	subFS, err := fs.Sub(staticFS, "static")
	if err != nil {
		fmt.Fprintf(os.Stderr, "stressui: embed fs: %v\n", err)
		os.Exit(1)
	}
	mux.Handle("/", http.FileServer(http.FS(subFS)))

	mux.HandleFunc("/api/run", s.handleRun)
	mux.HandleFunc("/api/jobs", s.handleListJobs)
	mux.HandleFunc("/api/jobs/", s.handleJobRoutes)
	mux.HandleFunc("/api/report", s.handleLatestReport)
	mux.HandleFunc("/api/summary", s.handleLatestSummary)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "ts": time.Now()})
	})

	fmt.Printf("stressui: listening on %s — open http://localhost%s\n", addr, normalizeAddrForURL(addr))
	if err := http.ListenAndServe(addr, mux); err != nil {
		fmt.Fprintf(os.Stderr, "stressui: server failed: %v\n", err)
		os.Exit(1)
	}
}

// ── HTTP handlers ──────────────────────────────────────────────────────────

func (s *server) handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Action  string `json:"action"`
		Confirm bool   `json:"confirm"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, fmt.Sprintf("decode body: %v", err), http.StatusBadRequest)
		return
	}
	cmd, err := s.commandFor(body.Action, body.Confirm)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	j := s.startJob(body.Action, cmd)
	writeJSON(w, http.StatusAccepted, j.snapshot())
}

func (s *server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]map[string]any, 0, len(s.jobs))
	for _, j := range s.jobs {
		out = append(out, j.snapshot())
	}
	sort.Slice(out, func(i, k int) bool {
		ti, _ := out[i]["started_at"].(time.Time)
		tk, _ := out[k]["started_at"].(time.Time)
		return ti.After(tk)
	})
	writeJSON(w, 200, out)
}

func (s *server) handleJobRoutes(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/jobs/")
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	id := parts[0]
	s.mu.Lock()
	j, ok := s.jobs[id]
	s.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	if len(parts) == 1 {
		writeJSON(w, 200, j.snapshot())
		return
	}
	switch parts[1] {
	case "stream":
		j.serveStream(w, r)
	case "logs":
		j.mu.Lock()
		logs := append([]logEntry(nil), j.logs...)
		j.mu.Unlock()
		writeJSON(w, 200, logs)
	case "stop":
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		j.stop()
		writeJSON(w, 200, j.snapshot())
	default:
		http.NotFound(w, r)
	}
}

func (s *server) handleLatestReport(w http.ResponseWriter, r *http.Request) {
	path, raw, err := latestFile(filepath.Join(s.root, resultsDir), verifyReportGlob)
	if err != nil {
		writeJSON(w, 200, map[string]any{"available": false})
		return
	}
	var parsed any
	_ = json.Unmarshal(raw, &parsed)
	writeJSON(w, 200, map[string]any{
		"available": true,
		"path":      filepath.Base(path),
		"report":    parsed,
	})
}

func (s *server) handleLatestSummary(w http.ResponseWriter, r *http.Request) {
	path, raw, err := latestFile(filepath.Join(s.root, resultsDir), k6SummaryGlob)
	if err != nil {
		writeJSON(w, 200, map[string]any{"available": false})
		return
	}
	var parsed any
	_ = json.Unmarshal(raw, &parsed)
	writeJSON(w, 200, map[string]any{
		"available": true,
		"path":      filepath.Base(path),
		"summary":   parsed,
	})
}

// ── command construction ──────────────────────────────────────────────────

func (s *server) commandFor(action string, confirm bool) (*exec.Cmd, error) {
	switch action {
	case "seed":
		return exec.Command("go", "run", "-tags", "stress_seed", "./cmd/stresstest"), nil
	case "verify":
		stamp := time.Now().Format("20060102_150405")
		out := filepath.Join(resultsDir, fmt.Sprintf("stress_report_%s.json", stamp))
		return exec.Command("go", "run", "-tags", "stress_verify", "./cmd/stresstest", "--out", out), nil
	case "cleanup":
		if !confirm {
			return nil, fmt.Errorf("cleanup requires confirm=true")
		}
		return exec.Command("go", "run", "-tags", "stress_cleanup", "./cmd/stresstest", "--confirm"), nil
	case "cleanup_dry_run":
		return exec.Command("go", "run", "-tags", "stress_cleanup", "./cmd/stresstest", "--dry-run"), nil
	case "k6":
		stamp := time.Now().Format("20060102_150405")
		summary := filepath.Join("..", resultsDir, fmt.Sprintf("k6_summary_%s.json", stamp))
		c := exec.Command("k6", "run", "--summary-export", summary, "stress_full.js")
		c.Dir = filepath.Join(s.root, "loadtest")
		return c, nil
	default:
		return nil, fmt.Errorf("unknown action %q (allowed: seed, k6, verify, cleanup, cleanup_dry_run)", action)
	}
}

// ── job lifecycle ──────────────────────────────────────────────────────────

func (s *server) startJob(action string, cmd *exec.Cmd) *job {
	id := newID()
	j := &job{
		ID:        id,
		Action:    action,
		StartedAt: time.Now(),
		Status:    "running",
		subs:      map[chan logEntry]struct{}{},
		done:      make(chan struct{}),
		cmd:       cmd,
	}
	s.mu.Lock()
	s.jobs[id] = j
	s.mu.Unlock()

	if cmd.Dir == "" {
		cmd.Dir = s.root
	}
	cmd.Env = os.Environ()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		j.fail(fmt.Errorf("stdout pipe: %w", err))
		return j
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		j.fail(fmt.Errorf("stderr pipe: %w", err))
		return j
	}

	j.appendLog(logEntry{TS: time.Now(), Stream: "system",
		Line: fmt.Sprintf("$ %s (cwd=%s)", strings.Join(cmd.Args, " "), cmd.Dir)})

	if err := cmd.Start(); err != nil {
		j.fail(fmt.Errorf("start: %w", err))
		return j
	}
	go j.pump(stdout, "stdout")
	go j.pump(stderr, "stderr")

	go func() {
		err := cmd.Wait()
		j.mu.Lock()
		now := time.Now()
		j.EndedAt = &now
		exit := 0
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				exit = ee.ExitCode()
			} else {
				exit = -1
			}
			j.Status = "error"
		} else {
			j.Status = "done"
		}
		j.ExitCode = &exit
		// Snapshot subs to close after releasing the lock.
		subs := j.subs
		j.subs = nil
		j.mu.Unlock()

		j.appendLog(logEntry{TS: now, Stream: "system",
			Line: fmt.Sprintf("--- exit %d (%s)", exit, j.Status)})
		close(j.done)
		for ch := range subs {
			close(ch)
		}
	}()

	return j
}

func (j *job) pump(r io.Reader, stream string) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		j.appendLog(logEntry{TS: time.Now(), Stream: stream, Line: scanner.Text()})
	}
}

func (j *job) appendLog(entry logEntry) {
	j.mu.Lock()
	j.logs = append(j.logs, entry)
	if len(j.logs) > maxLogLines {
		j.logs = j.logs[len(j.logs)-maxLogLines:]
	}
	subs := make([]chan logEntry, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- entry:
		default:
			// Slow consumer — drop the entry rather than block the pump.
		}
	}
}

func (j *job) fail(err error) {
	j.appendLog(logEntry{TS: time.Now(), Stream: "system", Line: "error: " + err.Error()})
	now := time.Now()
	exit := -1
	j.mu.Lock()
	j.Status = "error"
	j.EndedAt = &now
	j.ExitCode = &exit
	subs := j.subs
	j.subs = nil
	j.mu.Unlock()
	close(j.done)
	for ch := range subs {
		close(ch)
	}
}

func (j *job) stop() {
	if j.cmd != nil && j.cmd.Process != nil {
		_ = j.cmd.Process.Kill()
	}
}

func (j *job) snapshot() map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := map[string]any{
		"id":         j.ID,
		"action":     j.Action,
		"started_at": j.StartedAt,
		"status":     j.Status,
	}
	if j.EndedAt != nil {
		out["ended_at"] = *j.EndedAt
	}
	if j.ExitCode != nil {
		out["exit_code"] = *j.ExitCode
	}
	out["log_lines"] = len(j.logs)
	return out
}

func (j *job) serveStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := make(chan logEntry, 256)
	// Replay buffered logs first, then subscribe for live tail.
	j.mu.Lock()
	backlog := append([]logEntry(nil), j.logs...)
	live := j.subs != nil
	if live {
		j.subs[ch] = struct{}{}
	}
	j.mu.Unlock()

	for _, entry := range backlog {
		writeSSE(w, "log", entry)
	}
	flusher.Flush()

	if !live {
		// Job already completed before subscribing — emit final marker, exit.
		writeSSE(w, "end", j.snapshot())
		flusher.Flush()
		return
	}

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			j.mu.Lock()
			delete(j.subs, ch)
			j.mu.Unlock()
			return
		case entry, more := <-ch:
			if !more {
				writeSSE(w, "end", j.snapshot())
				flusher.Flush()
				return
			}
			writeSSE(w, "log", entry)
			flusher.Flush()
		}
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func (s *server) reapJobs() {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for range t.C {
		cutoff := time.Now().Add(-jobReaperAfter)
		s.mu.Lock()
		for id, j := range s.jobs {
			if j.EndedAt != nil && j.EndedAt.Before(cutoff) {
				delete(s.jobs, id)
			}
		}
		s.mu.Unlock()
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func writeSSE(w io.Writer, event string, data any) {
	buf, _ := json.Marshal(data)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, buf)
}

func latestFile(dir, pattern string) (string, []byte, error) {
	matches, err := filepath.Glob(filepath.Join(dir, pattern))
	if err != nil {
		return "", nil, err
	}
	if len(matches) == 0 {
		return "", nil, fmt.Errorf("no files match %s/%s", dir, pattern)
	}
	type stat struct {
		path string
		mod  time.Time
	}
	stats := make([]stat, 0, len(matches))
	for _, p := range matches {
		fi, err := os.Stat(p)
		if err != nil {
			continue
		}
		stats = append(stats, stat{p, fi.ModTime()})
	}
	if len(stats) == 0 {
		return "", nil, fmt.Errorf("no readable matches")
	}
	sort.Slice(stats, func(i, k int) bool { return stats[i].mod.After(stats[k].mod) })
	raw, err := os.ReadFile(stats[0].path)
	if err != nil {
		return "", nil, err
	}
	return stats[0].path, raw, nil
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func envOrDefault(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func requireEnv(k string) {
	if os.Getenv(k) == "" {
		fmt.Fprintf(os.Stderr, "stressui: $%s required\n", k)
		os.Exit(2)
	}
}

func normalizeAddrForURL(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return addr
	}
	return ":" + strings.TrimPrefix(addr, "0.0.0.0:")
}

// Force context import even if no exec timeout used yet (kept for future).
var _ = context.Background
