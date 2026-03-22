package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCodespaceUpdateCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/codespaces/cs-1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPatch {
			t.Errorf("unexpected method: %s", r.Method)
		}

		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "Renamed" {
			t.Errorf("request name = %v, want %q", body["name"], "Renamed")
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":        "cs-1",
				"name":      "Renamed",
				"path":      "/home/user/project",
				"createdAt": "2026-01-01T00:00:00Z",
				"updatedAt": "2026-01-02T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &CodespaceUpdateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-name", "Renamed", "cs-1"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestCodespaceUpdateCommand_Run_MissingID(t *testing.T) {
	cmd := &CodespaceUpdateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999", "-name", "Renamed"})
	if code != 1 {
		t.Errorf("Run() without ID = %d, want 1", code)
	}
}

func TestCodespaceUpdateCommand_Run_NoFlags(t *testing.T) {
	cmd := &CodespaceUpdateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999", "cs-1"})
	if code != 1 {
		t.Errorf("Run() without -name or -description = %d, want 1", code)
	}
}

func TestCodespaceUpdateCommand_Run_ServerError(t *testing.T) {
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

	cmd := &CodespaceUpdateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-name", "Renamed", "nonexistent"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestCodespaceUpdateCommand_Run_WithDescription(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["description"] != "Updated desc" {
			t.Errorf("request description = %v, want %q", body["description"], "Updated desc")
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "cs-1",
				"name":        "My Codespace",
				"path":        "/home/user/project",
				"description": "Updated desc",
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-02T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &CodespaceUpdateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-description", "Updated desc", "cs-1"})
	if code != 0 {
		t.Errorf("Run() with -description = %d, want 0", code)
	}
}

func TestCodespaceUpdateCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":        "cs-1",
				"name":      "Renamed",
				"path":      "/home/user/project",
				"createdAt": "2026-01-01T00:00:00Z",
				"updatedAt": "2026-01-02T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &CodespaceUpdateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-json", "-name", "Renamed", "cs-1"})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestCodespaceUpdateCommand_Synopsis(t *testing.T) {
	cmd := &CodespaceUpdateCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestCodespaceUpdateCommand_Help(t *testing.T) {
	cmd := &CodespaceUpdateCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
