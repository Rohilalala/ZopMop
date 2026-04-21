package analytics

import (
	"context"
	"testing"
)

func TestRefreshRollups_NilDB_ReturnsError(t *testing.T) {
	repo := &Repository{}

	err := repo.RefreshRollups(context.Background())
	if err == nil {
		t.Fatalf("expected error when repository db is nil")
	}
}
