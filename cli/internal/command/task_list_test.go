package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestTaskListCommand_Run_RequiresCodespace(t *testing.T) {
	// Ensure no env var interferes.
	os.Unsetenv("AP_CODESPACE")

	cmd := &TaskListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() without codespace = %d, want 1", code)
	}
}

func TestTaskListCommand_Run_CodespaceFromEnv(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		csID := r.URL.Query().Get("codespaceId")
		if csID != "cs-env" {
			t.Errorf("codespaceId query param = %q, want %q", csID, "cs-env")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": []interface{}{},
		})
	}))
	defer server.Close()

	os.Setenv("AP_CODESPACE", "cs-env")
	defer os.Unsetenv("AP_CODESPACE")

	cmd := &TaskListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token"})
	if code != 0 {
		t.Errorf("Run() with env codespace = %d, want 0", code)
	}
}

func TestTaskListCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		agentStatus := "running"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":              "task-1",
					"codespaceId":     "cs-1",
					"title":           "Implement feature",
					"column":          "in_progress",
					"priority":        "high",
					"lastAgentStatus": agentStatus,
					"labels":          []string{},
					"createdAt":       "2026-01-01T00:00:00Z",
					"updatedAt":       "2026-01-01T00:00:00Z",
				},
				{
					"id":          "task-2",
					"codespaceId": "cs-1",
					"title":       "Fix bug",
					"column":      "backlog",
					"priority":    "medium",
					"labels":      []string{},
					"createdAt":   "2026-01-02T00:00:00Z",
					"updatedAt":   "2026-01-02T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	cmd := &TaskListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-codespace", "cs-1"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestTaskListCommand_Run_WithColumnFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		col := r.URL.Query().Get("column")
		if col != "backlog" {
			t.Errorf("column query param = %q, want %q", col, "backlog")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": []interface{}{},
		})
	}))
	defer server.Close()

	cmd := &TaskListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-codespace", "cs-1",
		"-column", "backlog",
	})
	if code != 0 {
		t.Errorf("Run() with column filter = %d, want 0", code)
	}
}

func TestTaskListCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":          "task-1",
					"codespaceId": "cs-1",
					"title":       "Test task",
					"column":      "backlog",
					"priority":    "medium",
					"labels":      []string{},
					"createdAt":   "2026-01-01T00:00:00Z",
					"updatedAt":   "2026-01-01T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	cmd := &TaskListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-codespace", "cs-1",
		"-json",
	})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestTaskListCommand_Run_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "INTERNAL_ERROR",
				"message": "failure",
			},
		})
	}))
	defer server.Close()

	cmd := &TaskListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-codespace", "cs-1",
	})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestTaskListCommand_Synopsis(t *testing.T) {
	cmd := &TaskListCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestTaskListCommand_Help(t *testing.T) {
	cmd := &TaskListCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
