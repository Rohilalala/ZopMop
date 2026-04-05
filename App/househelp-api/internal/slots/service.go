package slots

import "context"

// Service is the business-logic layer for time slots.
type Service struct {
	repo *Repository
}

// NewService creates a new slots service.
func NewService(repo *Repository) *Service {
	return &Service{repo: repo}
}

// GetByDate returns future slots for a date, grouped into morning / afternoon /
// evening periods.  Past slots (start time < now + 30 min buffer) are excluded
// by the repository query.
func (s *Service) GetByDate(ctx context.Context, date string) ([]SlotPeriod, error) {
	slots, err := s.repo.GetByDate(ctx, date)
	if err != nil {
		return nil, err
	}
	return groupByPeriod(slots), nil
}

// IncrementBooking marks a slot as having one more booking.
func (s *Service) IncrementBooking(ctx context.Context, slotID string) error {
	return s.repo.IncrementBooking(ctx, slotID)
}

// groupByPeriod organises a flat slot list into the three named periods.
// Empty periods are omitted from the output.
func groupByPeriod(slots []TimeSlot) []SlotPeriod {
	buckets := map[string]*SlotPeriod{
		"morning":   {Label: "Morning"},
		"afternoon": {Label: "Afternoon"},
		"evening":   {Label: "Evening"},
	}
	order := []string{"morning", "afternoon", "evening"}

	for _, s := range slots {
		b := buckets[s.Period]
		b.Slots = append(b.Slots, s)
	}

	var out []SlotPeriod
	for _, key := range order {
		if len(buckets[key].Slots) > 0 {
			out = append(out, *buckets[key])
		}
	}
	return out
}
