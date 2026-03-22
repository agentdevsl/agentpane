package sdk

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSessions_List_WithFilters(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Query().Get("codespaceId") != "cs-1" {
			t.Errorf("expected codespaceId=cs-1, got %q", r.URL.Query().Get("codespaceId"))
		}
		if r.URL.Query().Get("status") != "active" {
			t.Errorf("expected status=active, got %q", r.URL.Query().Get("status"))
		}
		if r.URL.Query().Get("agentId") != "agent-1" {
			t.Errorf("expected agentId=agent-1, got %q", r.URL.Query().Get("agentId"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":          "sess-1",
					"codespaceId": "cs-1",
					"agentId":     "agent-1",
					"taskId":      "task-1",
					"status":      "active",
					"createdAt":   "2025-01-01T00:00:00Z",
					"updatedAt":   "2025-01-01T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Sessions.List(context.Background(), SessionListOptions{
		CodespaceID: "cs-1",
		Status:      "active",
		AgentID:     "agent-1",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 session, got %d", len(result))
	}
	if result[0].ID != "sess-1" {
		t.Errorf("expected ID 'sess-1', got %q", result[0].ID)
	}
	if result[0].Status != "active" {
		t.Errorf("expected status 'active', got %q", result[0].Status)
	}
}

func TestSessions_List_WithPagination(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "5" {
			t.Errorf("expected limit=5, got %q", r.URL.Query().Get("limit"))
		}
		if r.URL.Query().Get("offset") != "10" {
			t.Errorf("expected offset=10, got %q", r.URL.Query().Get("offset"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": []map[string]interface{}{},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Sessions.List(context.Background(), SessionListOptions{
		CodespaceID: "cs-1",
		Limit:       5,
		Offset:      10,
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestSessions_List_NoFilters(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Auto-pagination always sends limit and offset
		if r.URL.Query().Get("codespaceId") != "" {
			t.Errorf("expected no codespaceId filter, got %q", r.URL.Query().Get("codespaceId"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": map[string]interface{}{"items": []interface{}{}},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Sessions.List(context.Background(), SessionListOptions{})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestSessions_Get(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/sessions/sess-1" {
			t.Errorf("expected path /api/sessions/sess-1, got %s", r.URL.Path)
		}

		taskID := "task-1"
		agentID := "agent-1"
		title := "Planning session"
		sandbox := "docker"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":              "sess-1",
				"codespaceId":     "cs-1",
				"taskId":          taskID,
				"agentId":         agentID,
				"status":          "active",
				"title":           title,
				"sandboxProvider": sandbox,
				"createdAt":       "2025-01-01T00:00:00Z",
				"updatedAt":       "2025-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Sessions.Get(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ID != "sess-1" {
		t.Errorf("expected ID 'sess-1', got %q", result.ID)
	}
	if result.Status != "active" {
		t.Errorf("expected status 'active', got %q", result.Status)
	}
	if result.TaskID == nil || *result.TaskID != "task-1" {
		t.Errorf("expected taskId 'task-1', got %v", result.TaskID)
	}
	if result.AgentID == nil || *result.AgentID != "agent-1" {
		t.Errorf("expected agentId 'agent-1', got %v", result.AgentID)
	}
	if result.Title == nil || *result.Title != "Planning session" {
		t.Errorf("expected title 'Planning session', got %v", result.Title)
	}
	if result.SandboxProvider == nil || *result.SandboxProvider != "docker" {
		t.Errorf("expected sandboxProvider 'docker', got %v", result.SandboxProvider)
	}
}

func TestSessions_GetEvents(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/sessions/sess-1/events" {
			t.Errorf("expected path /api/sessions/sess-1/events, got %s", r.URL.Path)
		}
		if r.URL.Query().Get("limit") != "50" {
			t.Errorf("expected limit=50, got %q", r.URL.Query().Get("limit"))
		}
		if r.URL.Query().Get("offset") != "10" {
			t.Errorf("expected offset=10, got %q", r.URL.Query().Get("offset"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":        "evt-1",
					"type":      "agent:started",
					"timestamp": 1704067200000,
					"data":      map[string]string{"agentId": "agent-1"},
				},
				{
					"id":        "evt-2",
					"type":      "chunk",
					"timestamp": 1704067201000,
					"data":      map[string]string{"text": "Hello world"},
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Sessions.GetEvents(context.Background(), "sess-1", 50, 10)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 events, got %d", len(result))
	}
	if result[0].ID != "evt-1" {
		t.Errorf("expected first event ID 'evt-1', got %q", result[0].ID)
	}
	if result[0].Type != "agent:started" {
		t.Errorf("expected type 'agent:started', got %q", result[0].Type)
	}
	if result[0].Timestamp != 1704067200000 {
		t.Errorf("expected timestamp 1704067200000, got %d", result[0].Timestamp)
	}
	if result[1].Type != "chunk" {
		t.Errorf("expected second event type 'chunk', got %q", result[1].Type)
	}
}

func TestSessions_GetEvents_DefaultPagination(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// With limit=0 and offset=0, no query params should be sent
		if r.URL.RawQuery != "" {
			t.Errorf("expected no query params for default pagination, got %q", r.URL.RawQuery)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": []map[string]interface{}{},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Sessions.GetEvents(context.Background(), "sess-1", 0, 0)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestSessions_GetSummary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/sessions/sess-1/summary" {
			t.Errorf("expected path /api/sessions/sess-1/summary, got %s", r.URL.Path)
		}

		durationMs := int64(45000)
		finalStatus := "completed"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"sessionId":     "sess-1",
				"durationMs":    durationMs,
				"turnsCount":    15,
				"tokensUsed":    12500,
				"filesModified": 3,
				"linesAdded":    120,
				"linesRemoved":  30,
				"finalStatus":   finalStatus,
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Sessions.GetSummary(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.SessionID != "sess-1" {
		t.Errorf("expected sessionId 'sess-1', got %q", result.SessionID)
	}
	if result.DurationMs == nil || *result.DurationMs != 45000 {
		t.Errorf("expected durationMs 45000, got %v", result.DurationMs)
	}
	if result.TurnsCount != 15 {
		t.Errorf("expected turnsCount 15, got %d", result.TurnsCount)
	}
	if result.TokensUsed != 12500 {
		t.Errorf("expected tokensUsed 12500, got %d", result.TokensUsed)
	}
	if result.FilesModified != 3 {
		t.Errorf("expected filesModified 3, got %d", result.FilesModified)
	}
	if result.LinesAdded != 120 {
		t.Errorf("expected linesAdded 120, got %d", result.LinesAdded)
	}
	if result.LinesRemoved != 30 {
		t.Errorf("expected linesRemoved 30, got %d", result.LinesRemoved)
	}
	if result.FinalStatus == nil || *result.FinalStatus != "completed" {
		t.Errorf("expected finalStatus 'completed', got %v", result.FinalStatus)
	}
}

func TestSessions_Delete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/api/sessions/sess-1" {
			t.Errorf("expected path /api/sessions/sess-1, got %s", r.URL.Path)
		}

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Sessions.Delete(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}
