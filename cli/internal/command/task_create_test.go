package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestTaskCreateCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tasks" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method: %s", r.Method)
		}

		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["title"] != "Implement feature" {
			t.Errorf("request title = %v, want %q", body["title"], "Implement feature")
		}
		if body["codespaceId"] != "cs-1" {
			t.Errorf("request codespaceId = %v, want %q", body["codespaceId"], "cs-1")
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "task-new",
				"codespaceId": "cs-1",
				"title":       "Implement feature",
				"column":      "backlog",
				"priority":    "medium",
				"labels":      []string{},
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &TaskCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-codespace", "cs-1",
		"-title", "Implement feature",
	})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestTaskCreateCommand_Run_MissingCodespace(t *testing.T) {
	os.Unsetenv("AP_CODESPACE")

	cmd := &TaskCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", "http://localhost:9999",
		"-title", "Some task",
	})
	if code != 1 {
		t.Errorf("Run() without -codespace = %d, want 1", code)
	}
}

func TestTaskCreateCommand_Run_MissingTitle(t *testing.T) {
	cmd := &TaskCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", "http://localhost:9999",
		"-codespace", "cs-1",
	})
	if code != 1 {
		t.Errorf("Run() without -title = %d, want 1", code)
	}
}

func TestTaskCreateCommand_Run_ServerError(t *testing.T) {
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

	cmd := &TaskCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-codespace", "cs-1",
		"-title", "Fail",
	})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestTaskCreateCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "task-new",
				"codespaceId": "cs-1",
				"title":       "New task",
				"column":      "backlog",
				"priority":    "high",
				"labels":      []string{},
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &TaskCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-codespace", "cs-1",
		"-title", "New task",
		"-priority", "high",
		"-json",
	})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestTaskCreateCommand_Run_WithLabels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		labels, ok := body["labels"].([]interface{})
		if !ok || len(labels) != 2 {
			t.Errorf("expected 2 labels, got %v", body["labels"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "task-new",
				"codespaceId": "cs-1",
				"title":       "Labeled task",
				"column":      "backlog",
				"priority":    "medium",
				"labels":      []string{"bug", "urgent"},
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &TaskCreateCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-codespace", "cs-1",
		"-title", "Labeled task",
		"-labels", "bug,urgent",
	})
	if code != 0 {
		t.Errorf("Run() with -labels = %d, want 0", code)
	}
}

func TestTaskCreateCommand_Synopsis(t *testing.T) {
	cmd := &TaskCreateCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestTaskCreateCommand_Help(t *testing.T) {
	cmd := &TaskCreateCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
