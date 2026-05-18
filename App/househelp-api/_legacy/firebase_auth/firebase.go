package auth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"

	firebase "firebase.google.com/go/v4"
	firebaseauth "firebase.google.com/go/v4/auth"
	"google.golang.org/api/option"

	"github.com/adityarohilla/househelp-api/internal/credentials"
)

// firebaseVerifier is a singleton Firebase Auth client.
var (
	firebaseClient *firebaseauth.Client
	firebaseOnce   sync.Once
	firebaseErr    error
)

var (
	ErrFirebaseClientUnavailable = errors.New("firebase client unavailable")
	ErrInvalidFirebaseToken      = errors.New("invalid firebase token")
	ErrFirebasePhoneMissing      = errors.New("phone number not found in firebase token")
)

// getFirebaseClient returns the Firebase Auth client, initialising it once.
// It reads FIREBASE_CREDENTIALS_JSON from the environment, accepting either
// a file path (local dev) or the raw JSON blob (Railway / Fly / K8s secret
// injection). Falls back to Application Default Credentials if unset.
func getFirebaseClient(ctx context.Context) (*firebaseauth.Client, error) {
	firebaseOnce.Do(func() {
		var opts []option.ClientOption
		if opt := credentials.FirebaseOption(os.Getenv("FIREBASE_CREDENTIALS_JSON")); opt != nil {
			opts = append(opts, opt)
		}

		app, err := firebase.NewApp(ctx, nil, opts...)
		if err != nil {
			firebaseErr = fmt.Errorf("firebase init failed: %w", err)
			return
		}

		firebaseClient, firebaseErr = app.Auth(ctx)
	})
	return firebaseClient, firebaseErr
}

// VerifyFirebaseToken validates a Firebase ID token and returns
// the phone number extracted from it.
func VerifyFirebaseToken(ctx context.Context, idToken string) (string, error) {
	client, err := getFirebaseClient(ctx)
	if err != nil {
		return "", fmt.Errorf("%w", ErrFirebaseClientUnavailable)
	}

	token, err := client.VerifyIDToken(ctx, idToken)
	if err != nil {
		return "", fmt.Errorf("%w", ErrInvalidFirebaseToken)
	}

	phone, ok := token.Claims["phone_number"].(string)
	if !ok || phone == "" {
		return "", fmt.Errorf("%w", ErrFirebasePhoneMissing)
	}

	return phone, nil
}
