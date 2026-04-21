package reengagement

import (
	"context"
	"testing"
	"time"
)

type fakeRepo struct {
	mopping    []Candidate
	cart       []Candidate
	recorded   map[string]bool
	recordErr  error
	listErr    error
}

func (f *fakeRepo) ListMoppingDropoffCandidates(_ context.Context, _ time.Time, _ time.Duration) ([]Candidate, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.mopping, nil
}

func (f *fakeRepo) ListCartAbandonmentCandidates(_ context.Context, _ time.Time, _ time.Duration) ([]Candidate, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.cart, nil
}

func (f *fakeRepo) RecordSent(_ context.Context, userID, scenario string, windowStart time.Time, _ map[string]string) (bool, error) {
	if f.recordErr != nil {
		return false, f.recordErr
	}
	if f.recorded == nil {
		f.recorded = map[string]bool{}
	}
	key := userID + "|" + scenario + "|" + windowStart.UTC().Format(time.RFC3339)
	if f.recorded[key] {
		return false, nil
	}
	f.recorded[key] = true
	return true, nil
}

type sentNotif struct {
	userID   string
	title    string
	body     string
	scenario string
}

type fakeNotifier struct {
	sent []sentNotif
}

func (f *fakeNotifier) NotifyCustomerReengagement(_ context.Context, userID, title, body string, data map[string]string) error {
	f.sent = append(f.sent, sentNotif{
		userID:   userID,
		title:    title,
		body:     body,
		scenario: data["scenario"],
	})
	return nil
}

func (f *fakeNotifier) sentCount(userID, scenario string) int {
	total := 0
	for _, item := range f.sent {
		if item.userID == userID && item.scenario == scenario {
			total++
		}
	}
	return total
}

func (f *fakeNotifier) lastTitle() string {
	if len(f.sent) == 0 {
		return ""
	}
	return f.sent[len(f.sent)-1].title
}

func TestService_ProcessMoppingDropoff_DedupesByWindow(t *testing.T) {
	now := time.Date(2026, 4, 21, 18, 0, 0, 0, time.UTC)
	repo := &fakeRepo{
		mopping: []Candidate{
			{
				UserID:      "11111111-1111-1111-1111-111111111111",
				WindowStart: now.Add(-35 * time.Minute),
				ServiceName: "Mopping",
			},
		},
	}
	notif := &fakeNotifier{}
	svc := NewService(repo, notif, 30*time.Minute)

	if err := svc.ProcessMoppingDropoff(context.Background(), now); err != nil {
		t.Fatalf("first process failed: %v", err)
	}
	if err := svc.ProcessMoppingDropoff(context.Background(), now); err != nil {
		t.Fatalf("second process failed: %v", err)
	}

	if got := notif.sentCount("11111111-1111-1111-1111-111111111111", ScenarioMoppingDropoff); got != 1 {
		t.Fatalf("expected 1 reminder, got %d", got)
	}
}

func TestService_ProcessCartAbandonment_SendsPersonalizedReminder(t *testing.T) {
	now := time.Date(2026, 4, 21, 18, 0, 0, 0, time.UTC)
	repo := &fakeRepo{
		cart: []Candidate{
			{
				UserID:      "11111111-1111-1111-1111-111111111111",
				WindowStart: now.Add(-40 * time.Minute),
				CartCount:   2,
				ServiceName: "Kitchen Cleaning",
			},
		},
	}
	notif := &fakeNotifier{}
	svc := NewService(repo, notif, 30*time.Minute)

	if err := svc.ProcessCartAbandonment(context.Background(), now); err != nil {
		t.Fatalf("process failed: %v", err)
	}
	if got := notif.lastTitle(); got != "Still need Kitchen Cleaning?" {
		t.Fatalf("expected personalized title, got %q", got)
	}
}
