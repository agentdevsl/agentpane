package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestSessionListCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		csID := r.URL.Query().Get("codespaceId")
		if csID != "cs-1" {
			t.Errorf("codespaceId query param = %q, want %q", csID, "cs-1")
		}

		taskID := "task-1"
		agentID := "agent-1"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":          "sess-1",
					"codespaceId": "cs-1",
					"status":      "active",
					"taskId":      taskID,
					"agentId":     agentID,
					"createdAt":   "2026-01-01T00:00:00Z",
					"updatedAt":   "2026-01-01T00:00:00Z",
				},
				{
					"id":          "sess-2",
					"codespaceId": "cs-1",
					"status":      "closed",
					"createdAt":   "2026-01-02T00:00:00Z",
					"updatedAt":   "2026-01-02T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	cmd := &SessionListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-codespace", "cs-1"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestSessionListCommand_Run_RequiresCodespace(t *testing.T) {
	os.Unsetenv("AP_CODESPACE")

	cmd := &SessionListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() without codespace = %d, want 1", code)
	}
}

func TestSessionListCommand_Run_WithStatusFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		status := r.URL.Query().Get("status")
		if status != "active" {
			t.Errorf("status query param = %q, want %q", status, "active")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":          "sess-1",
					"codespaceId": "cs-1",
					"status":      "active",
					"createdAt":   "2026-01-01T00:00:00Z",
					"updatedAt":   "2026-01-01T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	cmd := &SessionListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-codespace", "cs-1",
		"-status", "active",
	})
	if code != 0 {
		t.Errorf("Run() with status filter = %d, want 0", code)
	}
}

func TestSessionListCommand_Run_Empty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": []interface{}{},
		})
	}))
	defer server.Close()

	cmd := &SessionListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-codespace", "cs-1"})
	if code != 0 {
		t.Errorf("Run() with empty list = %d, want 0", code)
	}
}

func TestSessionListCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":          "sess-1",
					"codespaceId": "cs-1",
					"status":      "active",
					"createdAt":   "2026-01-01T00:00:00Z",
					"updatedAt":   "2026-01-01T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	cmd := &SessionListCommand{Meta: NewMeta()}
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

func TestSessionListCommand_Run_ServerError(t *testing.T) {
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

	cmd := &SessionListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-codespace", "cs-1",
	})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestSessionListCommand_Synopsis(t *testing.T) {
	cmd := &SessionListCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestSessionListCommand_Help(t *testing.T) {
	cmd := &SessionListCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
