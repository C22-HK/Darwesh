// Package auth implements the password-reset email endpoint. The
// orchestration logic here (validation, rate limiting, enumeration-safety)
// is deliberately decoupled from the real Firebase Admin SDK and email API
// calls behind two small interfaces -- that's what makes it possible to
// unit-test the parts that matter (does this leak whether an email is
// registered? does the rate limiter actually block a burst?) without
// needing real credentials for either external service.
package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// ErrUserNotFound must be returned by a ResetLinkGenerator implementation
// when no account exists for the given email. The handler treats this
// identically to success in its HTTP response -- the one thing this
// whole file exists to get right is never letting an attacker learn
// which emails are registered by watching how this endpoint responds.
var ErrUserNotFound = errors.New("no account for this email")

// ResetLinkGenerator produces a real, Firebase-issued, single-use,
// expiring password-reset link for an email address. The production
// implementation (FirebaseResetLinkGenerator, in firebase_reset.go) calls
// the Firebase Admin SDK; tests use a fake.
type ResetLinkGenerator interface {
	GenerateResetLink(ctx context.Context, email string) (string, error)
}

// EmailSender delivers the branded reset email. The production
// implementation (ResendEmailSender, in resend_email.go) calls the Resend
// API; tests use a fake.
type EmailSender interface {
	SendResetEmail(ctx context.Context, toEmail, resetLink string) error
}

// Handler wires the two together with real validation, rate limiting, and
// enumeration-safe responses.
type Handler struct {
	Links   ResetLinkGenerator
	Emails  EmailSender
	Limiter *RateLimiter
	Logger  *slog.Logger
}

const genericResponseMessage = "If an account exists with this email address, we've sent instructions to reset your password."

// ForgotPassword handles POST /api/v1/auth/forgot-password.
func (h *Handler) ForgotPassword(c *gin.Context) {
	var body struct {
		Email string `json:"email"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Please provide a valid request body."})
		return
	}

	email := strings.TrimSpace(strings.ToLower(body.Email))
	if _, err := mail.ParseAddress(email); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "That email address doesn't look right."})
		return
	}

	// Rate limit BEFORE touching Firebase or the email API -- both cost
	// real money per call once real credentials are wired in, and this
	// is the endpoint most likely to be hammered by an attacker
	// enumerating emails or just abusing a free "send me mail" button.
	if !h.Limiter.Allow(c.ClientIP()) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many requests. Please wait a while and try again."})
		return
	}

	ctx := c.Request.Context()
	link, err := h.Links.GenerateResetLink(ctx, email)

	switch {
	case err == nil:
		if sendErr := h.Emails.SendResetEmail(ctx, email, link); sendErr != nil {
			// The reset link itself is never logged -- it's a live,
			// single-use credential. Only the fact that sending failed
			// is worth recording.
			h.Logger.Error("failed to send password reset email", "error", sendErr.Error())
		}
	case errors.Is(err, ErrUserNotFound):
		// Deliberately do nothing else -- fall through to the same
		// generic response as the success case below. This one branch
		// is the entire reason this endpoint exists instead of just
		// calling Firebase's client SDK directly from the browser: it
		// lets the server, not the client, decide what the visitor
		// sees, so "no such user" can never be distinguished from
		// "email sent" by anyone watching the response.
	default:
		h.Logger.Error("failed to generate password reset link", "error", err.Error())
		// Still return the generic message -- a transient failure on
		// our end shouldn't teach an attacker anything either, and a
		// real user who hits this can always just try again.
	}

	c.JSON(http.StatusOK, gin.H{"message": genericResponseMessage})
}

// RateLimiter is a simple in-memory fixed-window limiter, keyed by client
// IP. Deliberately not backed by Redis: at this project's current traffic
// (see docs/ARCHITECTURE_AUDIT.md), a single Cloud Run instance's own
// memory is sufficient, and adding Redis before there's a real multi-
// instance deployment to coordinate would be exactly the kind of
// unjustified complexity this project has been avoiding all along. If
// traffic ever grows enough to run multiple instances, this is the
// component to swap for a Redis-backed one -- the RateLimiter type is
// small and self-contained specifically so that swap is easy later.
type RateLimiter struct {
	mu       sync.Mutex
	requests map[string][]time.Time
	limit    int
	window   time.Duration
}

func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		requests: make(map[string][]time.Time),
		limit:    limit,
		window:   window,
	}
}

// Allow reports whether a new request from this key should proceed. Also
// opportunistically prunes old entries for this key so the map doesn't
// grow unbounded over the life of the process.
func (rl *RateLimiter) Allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	kept := rl.requests[key][:0]
	for _, t := range rl.requests[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}

	if len(kept) >= rl.limit {
		rl.requests[key] = kept
		return false
	}

	rl.requests[key] = append(kept, now)
	return true
}
