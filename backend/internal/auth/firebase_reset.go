package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"

	firebase "firebase.google.com/go/v4"
	fbauth "firebase.google.com/go/v4/auth"
	"google.golang.org/api/option"
)

// FirebaseResetLinkGenerator is the real, production ResetLinkGenerator --
// it calls the Firebase Admin SDK, the only thing that can legitimately
// mint one of these links (this is exactly the "generate the link
// server-side with the Admin SDK" requirement from the original spec).
// Needs a real service account JSON to do anything; see NewFirebaseResetLinkGenerator.
type FirebaseResetLinkGenerator struct {
	client *fbauth.Client
	// continueURL is where Firebase sends the visitor after they follow
	// the link -- this project's own reset-password.html, never an
	// arbitrary caller-supplied URL (an open redirect here would be a
	// real vulnerability: it's the one part of this flow a malicious
	// caller might try to control).
	continueURL string
}

// NewFirebaseResetLinkGenerator builds a real client from a service
// account JSON (the contents of the key file downloaded from Firebase
// Console -> Project Settings -> Service Accounts -> Generate new private
// key). Returns an error if the JSON is invalid -- this constructor does
// not silently degrade to a no-op the way error-monitor.js's empty-DSN
// check does, because "the backend claims to be ready but silently can't
// actually reset anyone's password" is a much worse failure mode than
// refusing to start.
func NewFirebaseResetLinkGenerator(ctx context.Context, serviceAccountJSON, continueURL string) (*FirebaseResetLinkGenerator, error) {
	if serviceAccountJSON == "" {
		return nil, errors.New("FIREBASE_SERVICE_ACCOUNT_JSON is not set")
	}
	if continueURL == "" {
		return nil, errors.New("RESET_PASSWORD_CONTINUE_URL is not set")
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(serviceAccountJSON), &probe); err != nil {
		return nil, fmt.Errorf("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: %w", err)
	}

	app, err := firebase.NewApp(ctx, nil, option.WithCredentialsJSON([]byte(serviceAccountJSON)))
	if err != nil {
		return nil, fmt.Errorf("initializing firebase app: %w", err)
	}
	client, err := app.Auth(ctx)
	if err != nil {
		return nil, fmt.Errorf("initializing firebase auth client: %w", err)
	}
	return &FirebaseResetLinkGenerator{client: client, continueURL: continueURL}, nil
}

func (g *FirebaseResetLinkGenerator) GenerateResetLink(ctx context.Context, email string) (string, error) {
	settings := &fbauth.ActionCodeSettings{URL: g.continueURL}
	rawLink, err := g.client.PasswordResetLinkWithSettings(ctx, email, settings)
	if err != nil {
		if fbauth.IsUserNotFound(err) {
			return "", ErrUserNotFound
		}
		return "", err
	}

	// The link Firebase generates always routes through
	// <project>.firebaseapp.com/__/auth/action first, which is exactly
	// the domain that turned out to be unreachable on some networks
	// (the reason this project's own reset-password.html was built in
	// the first place -- see its code comments). That's fine for
	// oobCode extraction (a plain query param), but we build the actual
	// link we email from scratch, pointed straight at our own page, so
	// the visitor's browser never has to load anything from
	// firebaseapp.com at all.
	oobCode, err := extractOobCode(rawLink)
	if err != nil {
		return "", fmt.Errorf("firebase returned a reset link in an unexpected format: %w", err)
	}

	direct, err := url.Parse(g.continueURL)
	if err != nil {
		return "", fmt.Errorf("invalid continue URL: %w", err)
	}
	q := direct.Query()
	q.Set("mode", "resetPassword")
	q.Set("oobCode", oobCode)
	direct.RawQuery = q.Encode()
	return direct.String(), nil
}

func extractOobCode(rawLink string) (string, error) {
	parsed, err := url.Parse(rawLink)
	if err != nil {
		return "", err
	}
	code := parsed.Query().Get("oobCode")
	if code == "" {
		return "", errors.New("no oobCode present in the generated link")
	}
	return code, nil
}
