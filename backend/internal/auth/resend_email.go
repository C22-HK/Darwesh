package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"time"
)

// ResendEmailSender sends the branded password-reset email via the Resend
// API (https://resend.com). Chosen as the example provider in
// docs/BACKEND_MILESTONES.md; swapping to SendGrid/Postmark/etc. later
// only means writing a new type that satisfies EmailSender -- nothing
// else in this package needs to change, which is the whole point of
// EmailSender being an interface.
type ResendEmailSender struct {
	apiKey     string
	fromHeader string // e.g. "Darwesh Group <no-reply@darweshgroup.com>"
	httpClient *http.Client
}

// NewResendEmailSender validates its inputs the same way
// NewFirebaseResetLinkGenerator does -- refuses to start rather than
// silently pretending emails are being sent.
func NewResendEmailSender(apiKey, fromHeader string) (*ResendEmailSender, error) {
	if apiKey == "" {
		return nil, errors.New("RESEND_API_KEY is not set")
	}
	if fromHeader == "" {
		return nil, errors.New("RESET_EMAIL_FROM is not set")
	}
	return &ResendEmailSender{
		apiKey:     apiKey,
		fromHeader: fromHeader,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}, nil
}

type resendRequest struct {
	From    string   `json:"from"`
	To      []string `json:"to"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html"`
}

func (s *ResendEmailSender) SendResetEmail(ctx context.Context, toEmail, resetLink string) error {
	payload := resendRequest{
		From:    s.fromHeader,
		To:      []string{toEmail},
		Subject: "Reset your Darwesh Group password",
		HTML:    resetEmailHTML(resetLink),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encoding email payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.resend.com/emails", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("building email request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+s.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("sending email: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		// Deliberately not including the response body in the error --
		// it could echo back the recipient address or other request
		// details, and this error only ever reaches server-side logs
		// (see reset.go's handler, which never surfaces send failures
		// to the HTTP caller), so there's no debugging benefit worth
		// the risk of it ending up somewhere it shouldn't.
		return fmt.Errorf("email provider returned status %d", resp.StatusCode)
	}
	return nil
}

// resetEmailHTML renders the branded email body. Uses inline CSS and
// table-based layout -- not because it's 2005, but because that's still
// what reliably renders consistently across Gmail, Outlook, and mobile
// mail clients, none of which fully support modern CSS in email.
func resetEmailHTML(resetLink string) string {
	safeLink := html.EscapeString(resetLink)
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#f1f4f9; font-family:Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f4f9; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:#ffffff; border-radius:16px; overflow:hidden;">
        <tr><td style="background-color:#041627; padding:28px 32px;">
          <span style="color:#ffffff; font-size:20px; font-weight:700;">Darwesh Group</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 16px; color:#181c20; font-size:20px;">Reset your password</h1>
          <p style="margin:0 0 20px; color:#44474c; font-size:14px; line-height:22px;">Hello,</p>
          <p style="margin:0 0 24px; color:#44474c; font-size:14px; line-height:22px;">
            We received a request to reset the password for your Darwesh Group account.
            Click the secure button below to choose a new password.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px; background-color:#041627;">
            <a href="` + safeLink + `" style="display:inline-block; padding:14px 28px; color:#ffffff; font-size:14px; font-weight:700; text-decoration:none; border-radius:8px;">Reset Password</a>
          </td></tr></table>
          <p style="margin:28px 0 0; color:#775a19; font-size:12.5px; line-height:19px;">
            For your security, this link is temporary and can only be used once.
          </p>
          <p style="margin:12px 0 0; color:#9aa1ab; font-size:12.5px; line-height:19px;">
            If you didn't request a password reset, you can safely ignore this email. Your account will remain secure.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px; background-color:#f7f9ff; border-top:1px solid #e5e8ee;">
          <p style="margin:0; color:#9aa1ab; font-size:11.5px; line-height:17px;">
            &copy; Darwesh Group. All rights reserved.<br/>
            www.darweshgroup.com &middot; This is an automated security email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}
