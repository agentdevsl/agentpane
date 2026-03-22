package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSessionEventsCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		expected := "/api/sessions/sess-1/events"
		if r.URL.Path != expected {
			t.Errorf("path = %q, want %q", r.URL.Path, expected)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":        "evt-1",
					"type":      "agent:started",
					"timestamp": 1735689600000,
					"data":      map[string]string{"agentId": "agent-1"},
				},
				{
					"id":        "evt-2",
					"type":      "agent:turn",
					"timestamp": 1735689610000,
					"data":      "turn completed",
				},
			},
		})
	}))
	defer server.Close()

	cmd := &SessionEventsCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "sess-1"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestSessionEventsCommand_Run_MissingID(t *testing.T) {
	cmd := &SessionEventsCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() without ID = %d, want 1", code)
	}
}

func TestSessionEventsCommand_Run_WithLimitFlag(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limit := r.URL.Query().Get("limit")
		if limit != "10" {
			t.Errorf("limit query param = %q, want %q", limit, "10")
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":        "evt-1",
					"type":      "agent:started",
					"timestamp": 1735689600000,
					"data":      nil,
				},
			},
		})
	}))
	defer server.Close()

	cmd := &SessionEventsCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-limit", "10",
		"sess-1",
	})
	if code != 0 {
		t.Errorf("Run() with -limit = %d, want 0", code)
	}
}

func TestSessionEventsCommand_Run_Empty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": []interface{}{},
		})
	}))
	defer server.Close()

	cmd := &SessionEventsCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "sess-1"})
	if code != 0 {
		t.Errorf("Run() with empty events = %d, want 0", code)
	}
}

func TestSessionEventsCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":        "evt-1",
					"type":      "agent:started",
					"timestamp": 1735689600000,
					"data":      "started",
				},
			},
		})
	}))
	defer server.Close()

	cmd := &SessionEventsCommand{Meta: NewMeta()}
	code := cmd.Run([]string{
		"-address", server.URL,
		"-token", "test-token",
		"-json",
		"sess-1",
	})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestSessionEventsCommand_Run_ServerError(t *testing.T) {
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

	cmd := &SessionEventsCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "nonexistent"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestSessionEventsCommand_Synopsis(t *testing.T) {
	cmd := &SessionEventsCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestSessionEventsCommand_Help(t *testing.T) {
	cmd := &SessionEventsCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
