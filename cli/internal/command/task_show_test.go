package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTaskShowCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tasks/task-abc" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "task-abc",
				"codespaceId": "cs-1",
				"title":       "Implement feature X",
				"column":      "in_progress",
				"priority":    "high",
				"labels":      []string{"backend"},
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &TaskShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "task-abc"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestTaskShowCommand_Run_MissingID(t *testing.T) {
	cmd := &TaskShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() without ID = %d, want 1", code)
	}
}

func TestTaskShowCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "task-abc",
				"codespaceId": "cs-1",
				"title":       "Implement feature X",
				"column":      "backlog",
				"priority":    "medium",
				"labels":      []string{},
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &TaskShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-json", "task-abc"})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestTaskShowCommand_Run_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "NOT_FOUND",
				"message": "task not found",
			},
		})
	}))
	defer server.Close()

	cmd := &TaskShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "nonexistent"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestTaskShowCommand_Synopsis(t *testing.T) {
	cmd := &TaskShowCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestTaskShowCommand_Help(t *testing.T) {
	cmd := &TaskShowCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
