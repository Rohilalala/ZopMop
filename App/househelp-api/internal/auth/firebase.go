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
// It reads FIREBASE_CREDENTIALS_JSON (a path to a service account JSON file)
// from the environment. Falls back to Application Default Credentials if unset.
func getFirebaseClient(ctx context.Context) (*firebaseauth.Client, error) {
	firebaseOnce.Do(func() {
		var opts []option.ClientOption
		if creds := os.Getenv("FIREBASE_CREDENTIALS_JSON"); creds != "" {
			opts = append(opts, option.WithCredentialsFile(creds))
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
