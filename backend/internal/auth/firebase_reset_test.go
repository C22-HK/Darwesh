package auth

import "testing"

func TestExtractOobCode_ParsesRealFirebaseLinkFormat(t *testing.T) {
	// This is the actual link shape Firebase generates (observed in
	// production) -- routes through the project's firebaseapp.com
	// authDomain first, which is what this whole extraction step exists
	// to avoid exposing to the visitor.
	rawLink := "https://darwesh-group.firebaseapp.com/__/auth/action?apiKey=AIzaSyBZQTkwRZNZL-HmNBx_i33QoSpSjIMin_8&mode=resetPassword&oobCode=85icZixsIrOUaSTdEjxDStVT8cu5DrY6QogRfpAyV5UAAAGgPzO7rw&continueUrl=https://www.darweshgroup.com/reset-password.html&lang=en"

	code, err := extractOobCode(rawLink)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != "85icZixsIrOUaSTdEjxDStVT8cu5DrY6QogRfpAyV5UAAAGgPzO7rw" {
		t.Fatalf("extracted wrong code: %q", code)
	}
}

func TestExtractOobCode_MissingCodeReturnsError(t *testing.T) {
	if _, err := extractOobCode("https://darwesh-group.firebaseapp.com/__/auth/action?mode=resetPassword"); err == nil {
		t.Fatal("expected an error when oobCode is missing from the link")
	}
}

func TestExtractOobCode_MalformedURLReturnsError(t *testing.T) {
	if _, err := extractOobCode("://not a url"); err == nil {
		t.Fatal("expected an error for a malformed URL")
	}
}
