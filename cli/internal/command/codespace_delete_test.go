package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCodespaceDeleteCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/codespaces/cs-1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodDelete {
			t.Errorf("unexpected method: %s", r.Method)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	cmd := &CodespaceDeleteCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "cs-1"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestCodespaceDeleteCommand_Run_MissingID(t *testing.T) {
	cmd := &CodespaceDeleteCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() without ID = %d, want 1", code)
	}
}

func TestCodespaceDeleteCommand_Run_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "NOT_FOUND",
				"message": "codespace not found",
			},
		})
	}))
	defer server.Close()

	cmd := &CodespaceDeleteCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "nonexistent"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestCodespaceDeleteCommand_Run_VerifiesRequestPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/api/codespaces/my-cs-id"
		if r.URL.Path != expected {
			t.Errorf("path = %q, want %q", r.URL.Path, expected)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	cmd := &CodespaceDeleteCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "tok", "my-cs-id"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestCodespaceDeleteCommand_Synopsis(t *testing.T) {
	cmd := &CodespaceDeleteCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestCodespaceDeleteCommand_Help(t *testing.T) {
	cmd := &CodespaceDeleteCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
