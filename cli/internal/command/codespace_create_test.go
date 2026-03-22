package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCodespaceCreateCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/codespaces" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method: %s", r.Method)
		}

		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "My Codespace" {
			t.Errorf("request name = %v, want %q", body["name"], "My Codespace")
		}
		if body["path"] != "/home/user/project" {
			t.Errorf("request path = %v, want %q", body["path"], "/home/user/project")
		}
		if body["projectFolderId"] != "proj-1" {
			t.Errorf("request projectFolderId = %v, want %q", body["projectFolderId"], "proj-1")
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":              "cs-new",
				"name":            "My Codespace",
				"path":            "/home/user/project",
				"projectFolderId": "proj-1",
				"createdAt":       "2026-01-01T00:00:00Z",
				"updatedAt":       "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &CodespaceCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-name", "My Codespace",
		"-path", "/home/user/project",
		"-project-id", "proj-1",
	})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestCodespaceCreateCommand_Run_MissingName(t *testing.T) {
	cmd := &CodespaceCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", "http://localhost:9999",
		"-path", "/home/user/project",
		"-project-id", "proj-1",
	})
	if code != 1 {
		t.Errorf("Run() without -name = %d, want 1", code)
	}
}

func TestCodespaceCreateCommand_Run_MissingPath(t *testing.T) {
	cmd := &CodespaceCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", "http://localhost:9999",
		"-name", "My Codespace",
		"-project-id", "proj-1",
	})
	if code != 1 {
		t.Errorf("Run() without -path = %d, want 1", code)
	}
}

func TestCodespaceCreateCommand_Run_MissingProjectID(t *testing.T) {
	cmd := &CodespaceCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", "http://localhost:9999",
		"-name", "My Codespace",
		"-path", "/home/user/project",
	})
	if code != 1 {
		t.Errorf("Run() without -project-id = %d, want 1", code)
	}
}

func TestCodespaceCreateCommand_Run_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "INTERNAL_ERROR",
				"message": "creation failed",
			},
		})
	}))
	defer server.Close()

	cmd := &CodespaceCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-name", "Fail",
		"-path", "/tmp",
		"-project-id", "proj-1",
	})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestCodespaceCreateCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":              "cs-new",
				"name":            "My Codespace",
				"path":            "/home/user/project",
				"projectFolderId": "proj-1",
				"createdAt":       "2026-01-01T00:00:00Z",
				"updatedAt":       "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &CodespaceCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-name", "My Codespace",
		"-path", "/home/user/project",
		"-project-id", "proj-1",
		"-json",
	})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestCodespaceCreateCommand_Synopsis(t *testing.T) {
	cmd := &CodespaceCreateCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestCodespaceCreateCommand_Help(t *testing.T) {
	cmd := &CodespaceCreateCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
