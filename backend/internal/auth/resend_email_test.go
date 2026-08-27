package auth

import (
	"strings"
	"testing"
)

func TestResetEmailHTML_EscapesTheLink(t *testing.T) {
	// The link is user-influenced in the sense that it embeds a
	// server-generated oobCode -- this test exists to make sure a
	// value containing HTML-special characters can never break out of
	// the href attribute into the surrounding markup.
	link := `https://www.darweshgroup.com/reset-password.html?oobCode=abc"><script>alert(1)</script>`
	out := resetEmailHTML(link)

	if strings.Contains(out, "<script>alert(1)</script>") {
		t.Fatal("resetEmailHTML did not escape an embedded script tag in the link")
	}
	if !strings.Contains(out, "&#34;") && !strings.Contains(out, "&quot;") {
		t.Fatal("expected the quote character in the link to be HTML-escaped")
	}
}

func TestResetEmailHTML_ContainsExpectedContent(t *testing.T) {
	out := resetEmailHTML("https://www.darweshgroup.com/reset-password.html?oobCode=xyz")

	for _, want := range []string{
		"Darwesh Group",
		"Reset Password",
		"oobCode=xyz",
		"can only be used once",
		"safely ignore this email",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("expected email HTML to contain %q, it didn't", want)
		}
	}
}
