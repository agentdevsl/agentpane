package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTaskMoveCommand_Run_RequiresArgs(t *testing.T) {
	cmd := &TaskMoveCommand{Meta: NewMeta()}

	// No positional args at all.
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() with no args = %d, want 1", code)
	}
}

func TestTaskMoveCommand_Run_RequiresTwoArgs(t *testing.T) {
	cmd := &TaskMoveCommand{Meta: NewMeta()}

	// Only one positional arg.
	code := cmd.Run([]string{"-address", "http://localhost:9999", "task-1"})
	if code != 1 {
		t.Errorf("Run() with one arg = %d, want 1", code)
	}
}

func TestTaskMoveCommand_Run_TooManyArgs(t *testing.T) {
	cmd := &TaskMoveCommand{Meta: NewMeta()}

	// Three positional args.
	code := cmd.Run([]string{"-address", "http://localhost:9999", "task-1", "backlog", "extra"})
	if code != 1 {
		t.Errorf("Run() with three args = %d, want 1", code)
	}
}

func TestTaskMoveCommand_Run_InvalidColumn(t *testing.T) {
	cmd := &TaskMoveCommand{Meta: NewMeta()}

	code := cmd.Run([]string{"-address", "http://localhost:9999", "task-1", "invalid_column"})
	if code != 1 {
		t.Errorf("Run() with invalid column = %d, want 1", code)
	}
}

func TestTaskMoveCommand_Run_ValidColumns(t *testing.T) {
	columns := []string{"backlog", "queued", "in_progress", "waiting_approval", "verified"}

	for _, col := range columns {
		col := col // capture range variable
		t.Run(col, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPatch {
					t.Errorf("unexpected method: %s", r.Method)
				}
				if !strings.HasPrefix(r.URL.Path, "/api/tasks/") || !strings.HasSuffix(r.URL.Path, "/move") {
					t.Errorf("unexpected path: %s", r.URL.Path)
				}

				var body map[string]interface{}
				json.NewDecoder(r.Body).Decode(&body)
				if body["column"] != col {
					t.Errorf("request column = %v, want %q", body["column"], col)
				}

				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]interface{}{
					"ok": true,
					"data": map[string]interface{}{
						"id":          "task-1",
						"codespaceId": "cs-1",
						"title":       "Test task",
						"column":      col,
						"priority":    "medium",
						"labels":      []string{},
						"createdAt":   "2026-01-01T00:00:00Z",
						"updatedAt":   "2026-01-01T00:00:00Z",
					},
				})
			}))
			defer server.Close()

			cmd := &TaskMoveCommand{Meta: NewMeta()}
			code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "task-1", col})
			if code != 0 {
				t.Errorf("Run() with column %q = %d, want 0", col, code)
			}
		})
	}
}

func TestTaskMoveCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "task-1",
				"codespaceId": "cs-1",
				"title":       "Test task",
				"column":      "queued",
				"priority":    "medium",
				"labels":      []string{},
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &TaskMoveCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-json", "task-1", "queued"})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestTaskMoveCommand_Run_ServerError(t *testing.T) {
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

	cmd := &TaskMoveCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "nonexistent", "backlog"})
	if code != 1 {
		t.Errorf("Run() on 404 = %d, want 1", code)
	}
}

func TestTaskMoveCommand_Run_VerifiesRequestPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify the full path includes the task ID.
		expected := "/api/tasks/my-task-id/move"
		if r.URL.Path != expected {
			t.Errorf("path = %q, want %q", r.URL.Path, expected)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "my-task-id",
				"codespaceId": "cs-1",
				"title":       "Test",
				"column":      "queued",
				"priority":    "medium",
				"labels":      []string{},
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &TaskMoveCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "tok", "my-task-id", "queued"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestTaskMoveCommand_Synopsis(t *testing.T) {
	cmd := &TaskMoveCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestTaskMoveCommand_Help(t *testing.T) {
	cmd := &TaskMoveCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
