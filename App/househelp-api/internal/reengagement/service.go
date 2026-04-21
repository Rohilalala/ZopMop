package reengagement

import (
	"context"
	"fmt"
	"strings"
	"time"
)

type candidateRepository interface {
	ListMoppingDropoffCandidates(ctx context.Context, now time.Time, delay time.Duration) ([]Candidate, error)
	ListCartAbandonmentCandidates(ctx context.Context, now time.Time, delay time.Duration) ([]Candidate, error)
	RecordSent(ctx context.Context, userID, scenario string, windowStart time.Time, payload map[string]string) (bool, error)
}

type Notifier interface {
	NotifyCustomerReengagement(ctx context.Context, userID, title, body string, data map[string]string) error
}

type Service struct {
	repo  candidateRepository
	notif Notifier
	delay time.Duration
}

func NewService(repo candidateRepository, notif Notifier, delay time.Duration) *Service {
	if delay <= 0 {
		delay = 30 * time.Minute
	}
	return &Service{
		repo:  repo,
		notif: notif,
		delay: delay,
	}
}

func (s *Service) ProcessMoppingDropoff(ctx context.Context, now time.Time) error {
	if s == nil || s.repo == nil || s.notif == nil {
		return nil
	}
	candidates, err := s.repo.ListMoppingDropoffCandidates(ctx, now, s.delay)
	if err != nil {
		return fmt.Errorf("list mopping candidates: %w", err)
	}
	for _, c := range candidates {
		title := "Finish your mopping booking"
		body := "Helpers nearby are available now. Complete your booking in a tap."
		if strings.TrimSpace(c.ServiceName) != "" {
			title = fmt.Sprintf("Need %s today?", strings.TrimSpace(c.ServiceName))
		}
		payload := map[string]string{
			"scenario":    ScenarioMoppingDropoff,
			"service_name": c.ServiceName,
		}
		recorded, err := s.repo.RecordSent(ctx, c.UserID, ScenarioMoppingDropoff, c.WindowStart, payload)
		if err != nil {
			return err
		}
		if !recorded {
			continue
		}
		if err := s.notif.NotifyCustomerReengagement(ctx, c.UserID, title, body, map[string]string{
			"type":     "reengagement",
			"scenario": ScenarioMoppingDropoff,
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) ProcessCartAbandonment(ctx context.Context, now time.Time) error {
	if s == nil || s.repo == nil || s.notif == nil {
		return nil
	}
	candidates, err := s.repo.ListCartAbandonmentCandidates(ctx, now, s.delay)
	if err != nil {
		return fmt.Errorf("list cart candidates: %w", err)
	}
	for _, c := range candidates {
		serviceName := strings.TrimSpace(c.ServiceName)
		if serviceName == "" {
			serviceName = "your service"
		}
		title := fmt.Sprintf("Still need %s?", serviceName)
		body := fmt.Sprintf("You have %d item(s) in cart. Complete your booking now.", c.CartCount)
		payload := map[string]string{
			"scenario":     ScenarioCartAbandonment,
			"service_name": serviceName,
			"cart_count":   fmt.Sprintf("%d", c.CartCount),
		}
		recorded, err := s.repo.RecordSent(ctx, c.UserID, ScenarioCartAbandonment, c.WindowStart, payload)
		if err != nil {
			return err
		}
		if !recorded {
			continue
		}
		if err := s.notif.NotifyCustomerReengagement(ctx, c.UserID, title, body, map[string]string{
			"type":     "reengagement",
			"scenario": ScenarioCartAbandonment,
		}); err != nil {
			return err
		}
	}
	return nil
}
