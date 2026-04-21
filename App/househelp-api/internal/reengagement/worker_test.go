package reengagement

import (
	"context"
	"testing"
	"time"
)

type fakeProcessService struct {
	moppingCalls int
	cartCalls    int
}

func (f *fakeProcessService) ProcessMoppingDropoff(_ context.Context, _ time.Time) error {
	f.moppingCalls++
	return nil
}

func (f *fakeProcessService) ProcessCartAbandonment(_ context.Context, _ time.Time) error {
	f.cartCalls++
	return nil
}

func TestWorker_RunOnce_ProcessesBothScenarios(t *testing.T) {
	svc := &fakeProcessService{}
	w := NewWorker(svc, time.Minute)

	w.runOnce()

	if svc.moppingCalls != 1 {
		t.Fatalf("expected 1 mopping call, got %d", svc.moppingCalls)
	}
	if svc.cartCalls != 1 {
		t.Fatalf("expected 1 cart call, got %d", svc.cartCalls)
	}
}
