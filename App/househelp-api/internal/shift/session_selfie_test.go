package shift_test

import (
	"context"
	"errors"
	"testing"

	"github.com/adityarohilla/househelp-api/internal/shift"
)

// Race guard: once a session is closed (manual go-offline, with a selfie), a
// later auto-close must be a no-op and must NOT overwrite offline_at / minutes /
// the selfie.
func TestCloseSession_SecondCloseDoesNotOverwrite(t *testing.T) {
	pool := openExpiryDB(t)
	ctx := context.Background()
	repo := shift.NewRepository(pool)
	_, _, sess := seedOnlinePro(t, pool, "00:00", "23:59")

	const realSelfie = "data:image/jpeg;base64,UkVBTA=="
	if _, err := repo.CloseSession(ctx, sess, realSelfie); err != nil {
		t.Fatalf("first close: %v", err)
	}
	// Racing auto-close (empty selfie) must be a benign no-op.
	if _, err := repo.CloseSession(ctx, sess, ""); err != nil {
		t.Fatalf("second close should be an idempotent no-op, got %v", err)
	}
	var url *string
	pool.QueryRow(ctx, `SELECT offline_selfie_url FROM shift_sessions WHERE id=$1::uuid`, sess).Scan(&url)
	if url == nil || *url != realSelfie {
		t.Errorf("offline_selfie_url was overwritten by the racing close: %v", url)
	}
}

// Mandatory + valid image selfie: go-online must reject an empty selfie AND any
// non-image data URL (a javascript:/data:text/html stored-XSS payload).
func TestGoOnline_RequiresSelfie(t *testing.T) {
	pool := openExpiryDB(t)
	svc := shift.NewService(shift.NewRepository(pool))
	for _, bad := range []string{"", "javascript:alert(1)", "data:text/html,<script>x</script>", "https://evil.example/x.png"} {
		_, err := svc.GoOnline(context.Background(), "00000000-0000-0000-0000-0000000000aa", "00000000-0000-0000-0000-0000000000bb", 28.4, 77.0, bad)
		if !errors.Is(err, shift.ErrSelfieRequired) {
			t.Fatalf("selfie %q: expected ErrSelfieRequired, got %v", bad, err)
		}
	}
}

// Mandatory selfie: manual go-offline with no selfie must be rejected.
func TestGoOffline_RequiresSelfie(t *testing.T) {
	pool := openExpiryDB(t)
	svc := shift.NewService(shift.NewRepository(pool))
	err := svc.GoOffline(context.Background(), "00000000-0000-0000-0000-0000000000aa", "00000000-0000-0000-0000-0000000000cc", "")
	if !errors.Is(err, shift.ErrSelfieRequired) {
		t.Fatalf("expected ErrSelfieRequired for empty go-offline selfie, got %v", err)
	}
}

// OpenSession persists the online selfie; "" is stored as NULL (auto paths).
func TestOpenSession_StoresOnlineSelfie(t *testing.T) {
	pool := openExpiryDB(t)
	ctx := context.Background()
	proID, commitID, _ := seedOnlinePro(t, pool, "00:00", "23:59")
	_ = commitID
	repo := shift.NewRepository(pool)

	const dataURL = "data:image/jpeg;base64,QUJD"
	sid, err := repo.OpenSession(ctx, commitID, proID, 28.4, 77.0, true, false, nil, dataURL)
	if err != nil {
		t.Fatalf("OpenSession: %v", err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM shift_sessions WHERE id=$1::uuid`, sid) })

	var got *string
	if err := pool.QueryRow(ctx, `SELECT online_selfie_url FROM shift_sessions WHERE id=$1::uuid`, sid).Scan(&got); err != nil {
		t.Fatalf("read online_selfie_url: %v", err)
	}
	if got == nil || *got != dataURL {
		t.Fatalf("online_selfie_url = %v, want %q", got, dataURL)
	}
}

// CloseSession persists the offline selfie when provided, and NULL when "".
func TestCloseSession_StoresOfflineSelfie(t *testing.T) {
	pool := openExpiryDB(t)
	ctx := context.Background()
	repo := shift.NewRepository(pool)

	// With a selfie.
	_, _, sessWith := seedOnlinePro(t, pool, "00:00", "23:59")
	const dataURL = "data:image/jpeg;base64,WFla"
	if _, err := repo.CloseSession(ctx, sessWith, dataURL); err != nil {
		t.Fatalf("CloseSession(with): %v", err)
	}
	var got *string
	pool.QueryRow(ctx, `SELECT offline_selfie_url FROM shift_sessions WHERE id=$1::uuid`, sessWith).Scan(&got)
	if got == nil || *got != dataURL {
		t.Fatalf("offline_selfie_url = %v, want %q", got, dataURL)
	}

	// Without (system force-offline) → NULL.
	_, _, sessAuto := seedOnlinePro(t, pool, "00:00", "23:59")
	if _, err := repo.CloseSession(ctx, sessAuto, ""); err != nil {
		t.Fatalf("CloseSession(auto): %v", err)
	}
	var auto *string
	pool.QueryRow(ctx, `SELECT offline_selfie_url FROM shift_sessions WHERE id=$1::uuid`, sessAuto).Scan(&auto)
	if auto != nil {
		t.Fatalf("offline_selfie_url for auto-offline = %v, want NULL", *auto)
	}
}
