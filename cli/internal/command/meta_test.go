package command

import (
	"os"
	"testing"
)

func TestNewMeta(t *testing.T) {
	m := NewMeta()
	if m == nil {
		t.Fatal("NewMeta() returned nil")
	}
}

func TestFlagSet_RegistersGlobalFlags(t *testing.T) {
	m := NewMeta()
	f := m.FlagSet("test")

	// Verify expected flags are registered.
	for _, name := range []string{"token", "address", "codespace", "json"} {
		if fl := f.Lookup(name); fl == nil {
			t.Errorf("expected flag %q to be registered", name)
		}
	}
}

func TestFlagSet_ParsesSetsValues(t *testing.T) {
	m := NewMeta()
	f := m.FlagSet("test")

	err := f.Parse([]string{
		"-token", "my-token",
		"-address", "http://example.com",
		"-codespace", "cs-123",
		"-json",
	})
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}

	if m.flagToken != "my-token" {
		t.Errorf("flagToken = %q, want %q", m.flagToken, "my-token")
	}
	if m.flagAddress != "http://example.com" {
		t.Errorf("flagAddress = %q, want %q", m.flagAddress, "http://example.com")
	}
	if m.flagCodespace != "cs-123" {
		t.Errorf("flagCodespace = %q, want %q", m.flagCodespace, "cs-123")
	}
	if !m.flagJSON {
		t.Error("flagJSON = false, want true")
	}
}

func TestClient_CreatesFromFlags(t *testing.T) {
	m := NewMeta()
	m.flagAddress = "http://localhost:9999"
	m.flagToken = "test-token"

	client, err := m.Client()
	if err != nil {
		t.Fatalf("Client() error: %v", err)
	}
	if client == nil {
		t.Fatal("Client() returned nil")
	}

	// Calling again returns the same cached instance.
	client2, err := m.Client()
	if err != nil {
		t.Fatalf("Client() second call error: %v", err)
	}
	if client != client2 {
		t.Error("expected Client() to return cached instance on second call")
	}
}

func TestClient_UsesEnvVars(t *testing.T) {
	// Set env vars and clear flags.
	os.Setenv("AP_ADDRESS", "http://env-host:4000")
	os.Setenv("AP_TOKEN", "env-token")
	defer os.Unsetenv("AP_ADDRESS")
	defer os.Unsetenv("AP_TOKEN")

	m := NewMeta()
	// Leave flagAddress and flagToken empty so env vars are used.

	client, err := m.Client()
	if err != nil {
		t.Fatalf("Client() error: %v", err)
	}
	if client == nil {
		t.Fatal("Client() returned nil")
	}
}

func TestClient_DefaultAddress(t *testing.T) {
	// Ensure no env vars interfere.
	os.Unsetenv("AP_ADDRESS")
	os.Unsetenv("AP_TOKEN")

	m := NewMeta()
	client, err := m.Client()
	if err != nil {
		t.Fatalf("Client() error: %v", err)
	}
	if client == nil {
		t.Fatal("Client() returned nil with default address")
	}
}

func TestCodespaceID_FromFlag(t *testing.T) {
	m := NewMeta()
	m.flagCodespace = "cs-flag"

	got := m.CodespaceID()
	if got != "cs-flag" {
		t.Errorf("CodespaceID() = %q, want %q", got, "cs-flag")
	}
}

func TestCodespaceID_FromEnv(t *testing.T) {
	os.Setenv("AP_CODESPACE", "cs-env")
	defer os.Unsetenv("AP_CODESPACE")

	m := NewMeta()
	got := m.CodespaceID()
	if got != "cs-env" {
		t.Errorf("CodespaceID() = %q, want %q", got, "cs-env")
	}
}

func TestCodespaceID_FlagPrecedence(t *testing.T) {
	os.Setenv("AP_CODESPACE", "cs-env")
	defer os.Unsetenv("AP_CODESPACE")

	m := NewMeta()
	m.flagCodespace = "cs-flag"

	got := m.CodespaceID()
	if got != "cs-flag" {
		t.Errorf("CodespaceID() = %q, want %q (flag should take precedence)", got, "cs-flag")
	}
}

func TestCodespaceID_Empty(t *testing.T) {
	os.Unsetenv("AP_CODESPACE")

	m := NewMeta()
	got := m.CodespaceID()
	if got != "" {
		t.Errorf("CodespaceID() = %q, want empty string", got)
	}
}

func TestJSONOutput(t *testing.T) {
	m := NewMeta()
	if m.JSONOutput() {
		t.Error("JSONOutput() = true before flag set, want false")
	}

	m.flagJSON = true
	if !m.JSONOutput() {
		t.Error("JSONOutput() = false after flag set, want true")
	}
}
