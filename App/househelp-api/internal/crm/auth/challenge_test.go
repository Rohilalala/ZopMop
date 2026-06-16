package auth

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestConsumeChallenge_SingleUse proves the TOTP challenge jti is single-use
// (the fix for replayable challenge tokens minting unlimited sessions):
// the first consume is fresh, a replay of the same jti is rejected, and a
// distinct jti is independent.
func TestConsumeChallenge_SingleUse(t *testing.T) {
	pool := openCRMTestDB(t)
	repo := NewRepository(pool)
	adminID := makeTestAdmin(t, pool)
	ctx := context.Background()
	exp := time.Now().Add(5 * time.Minute)

	jti := uuid.NewString()
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM crm_used_challenges WHERE jti=$1::uuid`, jti) })

	fresh, err := repo.ConsumeChallenge(ctx, jti, adminID, exp)
	if err != nil {
		t.Fatalf("first consume: %v", err)
	}
	if !fresh {
		t.Fatal("first consume of a challenge must be fresh=true")
	}

	// Replay: same jti again — must be rejected, NOT an error.
	replay, err := repo.ConsumeChallenge(ctx, jti, adminID, exp)
	if err != nil {
		t.Fatalf("replay consume errored: %v", err)
	}
	if replay {
		t.Fatal("replay of an already-consumed challenge must be fresh=false")
	}

	// A different challenge is independent.
	jti2 := uuid.NewString()
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM crm_used_challenges WHERE jti=$1::uuid`, jti2) })
	fresh2, err := repo.ConsumeChallenge(ctx, jti2, adminID, exp)
	if err != nil || !fresh2 {
		t.Fatalf("distinct jti: fresh=%v err=%v (want fresh=true, no err)", fresh2, err)
	}
}
