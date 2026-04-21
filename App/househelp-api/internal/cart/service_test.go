package cart

import (
	"context"
	"testing"
)

type fakeCartRepo struct {
	cart       *Cart
	priceCents int
}

func (f *fakeCartRepo) GetCartByUserID(_ context.Context, _ string) (*Cart, error) {
	return f.cart, nil
}

func (f *fakeCartRepo) GetServicePrice(_ context.Context, _ string, _ int) (int, error) {
	return f.priceCents, nil
}

func (f *fakeCartRepo) GetOrCreateCart(_ context.Context, _ string) (*Cart, error) {
	return f.cart, nil
}

func (f *fakeCartRepo) AddItem(_ context.Context, _, _ string, _, _ int) (*CartItem, error) {
	return &CartItem{ID: "item-1"}, nil
}

func (f *fakeCartRepo) RemoveItem(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeCartRepo) ClearCart(_ context.Context, _ string) error {
	return nil
}

type trackedCall struct {
	eventName string
	userID    string
	props     map[string]string
}

type fakeAnalytics struct {
	calls []trackedCall
}

func (f *fakeAnalytics) Track(_ context.Context, eventName, userID, _ string, props map[string]string) {
	f.calls = append(f.calls, trackedCall{
		eventName: eventName,
		userID:    userID,
		props:     props,
	})
}

func TestService_AddItem_TracksCartItemAdded(t *testing.T) {
	repo := &fakeCartRepo{
		cart: &Cart{
			ID:     "cart-1",
			UserID: "11111111-1111-1111-1111-111111111111",
		},
		priceCents: 19900,
	}
	analytics := &fakeAnalytics{}
	svc := NewService(repo)
	svc.SetAnalytics(analytics)

	_, err := svc.AddItem(context.Background(), "11111111-1111-1111-1111-111111111111", AddItemRequest{
		ServiceID:       "service-1",
		DurationMinutes: 60,
	})
	if err != nil {
		t.Fatalf("AddItem failed: %v", err)
	}

	if len(analytics.calls) != 1 {
		t.Fatalf("expected 1 analytics call, got %d", len(analytics.calls))
	}
	call := analytics.calls[0]
	if call.eventName != "cart.item_added" {
		t.Fatalf("expected cart.item_added event, got %s", call.eventName)
	}
	if call.userID != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("expected user_id propagated")
	}
	if call.props["service_id"] != "service-1" {
		t.Fatalf("expected service_id in props")
	}
}
