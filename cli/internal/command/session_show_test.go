package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionShowCommand_Run_SuccessWithSummary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if strings.HasSuffix(r.URL.Path, "/summary") {
			// Summary endpoint
			durationMs := int64(12500)
			finalStatus := "completed"
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"data": map[string]interface{}{
					"sessionId":     "sess-1",
					"turnsCount":    10,
					"tokensUsed":    5000,
					"filesModified": 3,
					"linesAdded":    120,
					"linesRemoved":  45,
					"durationMs":    durationMs,
					"finalStatus":   finalStatus,
				},
			})
			return
		}

		// Session detail endpoint
		if r.URL.Path != "/api/sessions/sess-1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}

		taskID := "task-1"
		agentID := "agent-1"
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "sess-1",
				"codespaceId": "cs-1",
				"status":      "closed",
				"taskId":      taskID,
				"agentId":     agentID,
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T12:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &SessionShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "sess-1"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestSessionShowCommand_Run_MissingID(t *testing.T) {
	cmd := &SessionShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() without ID = %d, want 1", code)
	}
}

func TestSessionShowCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if strings.HasSuffix(r.URL.Path, "/summary") {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"data": map[string]interface{}{
					"sessionId":     "sess-1",
					"turnsCount":    5,
					"tokensUsed":    2000,
					"filesModified": 1,
					"linesAdded":    30,
					"linesRemoved":  10,
				},
			})
			return
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "sess-1",
				"codespaceId": "cs-1",
				"status":      "active",
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &SessionShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-json", "sess-1"})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestSessionShowCommand_Run_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "NOT_FOUND",
				"message": "session not found",
			},
		})
	}))
	defer server.Close()

	cmd := &SessionShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "nonexistent"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestSessionShowCommand_Run_SummaryNotFound(t *testing.T) {
	// Session exists but summary returns 404 -- should still succeed.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if strings.HasSuffix(r.URL.Path, "/summary") {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": false,
				"error": map[string]string{
					"code":    "NOT_FOUND",
					"message": "summary not found",
				},
			})
			return
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "sess-1",
				"codespaceId": "cs-1",
				"status":      "active",
				"createdAt":   "2026-01-01T00:00:00Z",
				"updatedAt":   "2026-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	cmd := &SessionShowCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "sess-1"})
	if code != 0 {
		t.Errorf("Run() with missing summary = %d, want 0", code)
	}
}

func TestSessionShowCommand_Synopsis(t *testing.T) {
	cmd := &SessionShowCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestSessionShowCommand_Help(t *testing.T) {
	cmd := &SessionShowCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
