package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCodespaceShowCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/codespaces/cs-1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}

		desc := "A test codespace"
		owner := "myorg"
		repo := "myrepo"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":                  "cs-1",
				"name":                "My Codespace",
				"path":                "/home/user/project",
				"projectFolderId":     "proj-1",
				"maxConcurrentAgents": 3,
				"description":         desc,
				"githubOwner":         owner,
				"githubRepo":          repo,
				"createdAt":           "2026-01-01T00:00:00Z",
				"updatedAt":           "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &CodespaceShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "cs-1"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestCodespaceShowCommand_Run_MissingID(t *testing.T) {
	cmd := &CodespaceShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() without ID = %d, want 1", code)
	}
}

func TestCodespaceShowCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":                  "cs-1",
				"name":                "My Codespace",
				"path":                "/home/user/project",
				"projectFolderId":     "proj-1",
				"maxConcurrentAgents": 2,
				"createdAt":           "2026-01-01T00:00:00Z",
				"updatedAt":           "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &CodespaceShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-json", "cs-1"})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestCodespaceShowCommand_Run_ServerError(t *testing.T) {
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

	cmd := &CodespaceShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "nonexistent"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestCodespaceShowCommand_Synopsis(t *testing.T) {
	cmd := &CodespaceShowCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestCodespaceShowCommand_Help(t *testing.T) {
	cmd := &CodespaceShowCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
