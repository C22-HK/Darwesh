package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

type fakeLinks struct {
	linksByEmail map[string]string
	errsByEmail  map[string]error
	calls        []string
}

func (f *fakeLinks) GenerateResetLink(ctx context.Context, email string) (string, error) {
	f.calls = append(f.calls, email)
	if err, ok := f.errsByEmail[email]; ok {
		return "", err
	}
	if link, ok := f.linksByEmail[email]; ok {
		return link, nil
	}
	return "", ErrUserNotFound
}

type fakeEmails struct {
	sent []string
	err  error
}

func (f *fakeEmails) SendResetEmail(ctx context.Context, toEmail, resetLink string) error {
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, toEmail+"|"+resetLink)
	return nil
}

func newTestHandler(links *fakeLinks, emails *fakeEmails) (*Handler, *gin.Engine) {
	gin.SetMode(gin.TestMode)
	h := &Handler{
		Links:   links,
		Emails:  emails,
		Limiter: NewRateLimiter(1000, time.Minute), // effectively unlimited unless a test says otherwise
		Logger:  testLogger(),
	}
	r := gin.New()
	r.POST("/api/v1/auth/forgot-password", h.ForgotPassword)
	return h, r
}

func postJSON(r *gin.Engine, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/forgot-password", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func responseMessage(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("could not parse response body %q: %v", rec.Body.String(), err)
	}
	if msg, ok := body["message"]; ok {
		return msg
	}
	return body["error"]
}

func TestForgotPassword_RegisteredEmail_SendsLinkAndReturnsGenericMessage(t *testing.T) {
	links := &fakeLinks{linksByEmail: map[string]string{"real@example.com": "https://www.darweshgroup.com/reset-password.html?oobCode=abc123"}}
	emails := &fakeEmails{}
	_, r := newTestHandler(links, emails)

	rec := postJSON(r, `{"email":"real@example.com"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(emails.sent) != 1 {
		t.Fatalf("expected exactly one email sent, got %d", len(emails.sent))
	}
	if !strings.Contains(emails.sent[0], "real@example.com") || !strings.Contains(emails.sent[0], "oobCode=abc123") {
		t.Fatalf("email was not sent with the right recipient/link: %v", emails.sent)
	}
}

func TestForgotPassword_UnregisteredEmail_ReturnsIdenticalResponseAndSendsNoEmail(t *testing.T) {
	links := &fakeLinks{} // no entries -- every email is "not found"
	emails := &fakeEmails{}
	_, r := newTestHandler(links, emails)

	regReq := postJSON(r, `{"email":"real@example.com"}`)
	unregReq := postJSON(r, `{"email":"doesnotexist@example.com"}`)

	if regReq.Code != http.StatusOK || unregReq.Code != http.StatusOK {
		t.Fatalf("expected both to return 200 regardless of registration, got %d and %d", regReq.Code, unregReq.Code)
	}
	if responseMessage(t, regReq) != responseMessage(t, unregReq) {
		t.Fatalf("registered vs unregistered responses differ -- this leaks account existence:\n  registered:   %q\n  unregistered: %q",
			responseMessage(t, regReq), responseMessage(t, unregReq))
	}
	if len(emails.sent) != 0 {
		t.Fatalf("expected no email sent for an unregistered address, got %d", len(emails.sent))
	}
}

func TestForgotPassword_InvalidEmailFormat_ReturnsDistinctValidationError(t *testing.T) {
	// This one IS allowed to differ from the generic message -- a
	// malformed email address is a format problem, not an
	// account-existence signal, so telling the user is fine and helpful.
	links := &fakeLinks{}
	emails := &fakeEmails{}
	_, r := newTestHandler(links, emails)

	rec := postJSON(r, `{"email":"not-an-email"}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed email, got %d", rec.Code)
	}
	if len(links.calls) != 0 {
		t.Fatalf("should never call the link generator for a malformed email, got %d calls", len(links.calls))
	}
}

func TestForgotPassword_GeneratorFailure_StillReturnsGenericSuccessMessage(t *testing.T) {
	links := &fakeLinks{errsByEmail: map[string]error{"real@example.com": errors.New("firebase is down")}}
	emails := &fakeEmails{}
	_, r := newTestHandler(links, emails)

	rec := postJSON(r, `{"email":"real@example.com"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 even on an internal failure (never leak that to the client), got %d", rec.Code)
	}
	if responseMessage(t, rec) != genericResponseMessage {
		t.Fatalf("expected the generic message even on internal failure, got %q", responseMessage(t, rec))
	}
	if len(emails.sent) != 0 {
		t.Fatalf("should not attempt to send an email when link generation failed, got %d", len(emails.sent))
	}
}

func TestForgotPassword_RateLimitBlocksBurst(t *testing.T) {
	links := &fakeLinks{linksByEmail: map[string]string{"real@example.com": "https://example.com/reset"}}
	emails := &fakeEmails{}
	gin.SetMode(gin.TestMode)
	h := &Handler{Links: links, Emails: emails, Limiter: NewRateLimiter(2, time.Minute), Logger: testLogger()}
	r := gin.New()
	r.POST("/api/v1/auth/forgot-password", h.ForgotPassword)

	first := postJSON(r, `{"email":"real@example.com"}`)
	second := postJSON(r, `{"email":"real@example.com"}`)
	third := postJSON(r, `{"email":"real@example.com"}`)

	if first.Code != http.StatusOK || second.Code != http.StatusOK {
		t.Fatalf("expected the first 2 requests (within the limit) to succeed, got %d and %d", first.Code, second.Code)
	}
	if third.Code != http.StatusTooManyRequests {
		t.Fatalf("expected the 3rd request to be rate-limited (429), got %d", third.Code)
	}
	if len(emails.sent) != 2 {
		t.Fatalf("expected exactly 2 emails sent before the limit kicked in, got %d", len(emails.sent))
	}
}

func TestRateLimiter_AllowsAgainAfterWindowExpires(t *testing.T) {
	rl := NewRateLimiter(1, 30*time.Millisecond)
	if !rl.Allow("1.2.3.4") {
		t.Fatal("expected the first request to be allowed")
	}
	if rl.Allow("1.2.3.4") {
		t.Fatal("expected the second immediate request to be blocked")
	}
	time.Sleep(40 * time.Millisecond)
	if !rl.Allow("1.2.3.4") {
		t.Fatal("expected a request after the window expired to be allowed again")
	}
}

func TestRateLimiter_TracksKeysIndependently(t *testing.T) {
	rl := NewRateLimiter(1, time.Minute)
	if !rl.Allow("1.1.1.1") {
		t.Fatal("expected first IP's first request to be allowed")
	}
	if !rl.Allow("2.2.2.2") {
		t.Fatal("expected a different IP to have its own independent limit")
	}
	if rl.Allow("1.1.1.1") {
		t.Fatal("expected first IP's second request to still be blocked")
	}
}
