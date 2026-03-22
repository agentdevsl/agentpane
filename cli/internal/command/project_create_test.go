package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProjectCreateCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/project-folders" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method: %s", r.Method)
		}

		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "New Project" {
			t.Errorf("request name = %v, want %q", body["name"], "New Project")
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":        "proj-new",
				"name":      "New Project",
				"slug":      "new-project",
				"icon":      "folder",
				"color":     "blue",
				"createdAt": "2026-01-01T00:00:00Z",
				"updatedAt": "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &ProjectCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-name", "New Project"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestProjectCreateCommand_Run_MissingName(t *testing.T) {
	cmd := &ProjectCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() without -name = %d, want 1", code)
	}
}

func TestProjectCreateCommand_Run_ServerError(t *testing.T) {
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

	cmd := &ProjectCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-name", "Fail"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestProjectCreateCommand_Run_WithDescription(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["description"] != "A test project" {
			t.Errorf("request description = %v, want %q", body["description"], "A test project")
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "proj-new",
				"name":        "Described",
				"slug":        "described",
				"description": "A test project",
				"icon":        "folder",
				"color":       "blue",
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &ProjectCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-name", "Described", "-description", "A test project"})
	if code != 0 {
		t.Errorf("Run() with description = %d, want 0", code)
	}
}

func TestProjectCreateCommand_Synopsis(t *testing.T) {
	cmd := &ProjectCreateCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestProjectCreateCommand_Help(t *testing.T) {
	cmd := &ProjectCreateCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
