package sdk

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAgents_List_WithCodespaceFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Query().Get("codespaceId") != "cs-1" {
			t.Errorf("expected codespaceId=cs-1, got %q", r.URL.Query().Get("codespaceId"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":          "agent-1",
					"codespaceId": "cs-1",
					"name":        "Agent Alpha",
					"type":        "task",
					"status":      "idle",
					"currentTurn": 0,
					"createdAt":   "2025-01-01T00:00:00Z",
					"updatedAt":   "2025-01-01T00:00:00Z",
				},
				{
					"id":          "agent-2",
					"codespaceId": "cs-1",
					"name":        "Agent Beta",
					"type":        "task",
					"status":      "running",
					"currentTurn": 5,
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

	result, err := client.Agents.List(context.Background(), "cs-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 agents, got %d", len(result))
	}
	if result[0].ID != "agent-1" {
		t.Errorf("expected first agent ID 'agent-1', got %q", result[0].ID)
	}
	if result[0].Status != "idle" {
		t.Errorf("expected status 'idle', got %q", result[0].Status)
	}
	if result[1].Status != "running" {
		t.Errorf("expected second agent status 'running', got %q", result[1].Status)
	}
	if result[1].CurrentTurn != 5 {
		t.Errorf("expected currentTurn 5, got %d", result[1].CurrentTurn)
	}
}

func TestAgents_List_NoFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" {
			t.Errorf("expected no query params for empty codespaceID, got %q", r.URL.RawQuery)
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

	result, err := client.Agents.List(context.Background(), "")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected 0 agents, got %d", len(result))
	}
}

func TestAgents_Get(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/agents/agent-1" {
			t.Errorf("expected path /api/agents/agent-1, got %s", r.URL.Path)
		}

		taskID := "task-1"
		sessionID := "sess-1"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":               "agent-1",
				"codespaceId":      "cs-1",
				"name":             "Agent Alpha",
				"type":             "task",
				"status":           "running",
				"currentTaskId":    taskID,
				"currentSessionId": sessionID,
				"currentTurn":      12,
				"createdAt":        "2025-01-01T00:00:00Z",
				"updatedAt":        "2025-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Agents.Get(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ID != "agent-1" {
		t.Errorf("expected ID 'agent-1', got %q", result.ID)
	}
	if result.Name != "Agent Alpha" {
		t.Errorf("expected name 'Agent Alpha', got %q", result.Name)
	}
	if result.Status != "running" {
		t.Errorf("expected status 'running', got %q", result.Status)
	}
	if result.CurrentTurn != 12 {
		t.Errorf("expected currentTurn 12, got %d", result.CurrentTurn)
	}
	if result.CurrentTaskID == nil || *result.CurrentTaskID != "task-1" {
		t.Errorf("expected currentTaskId 'task-1', got %v", result.CurrentTaskID)
	}
	if result.CurrentSessionID == nil || *result.CurrentSessionID != "sess-1" {
		t.Errorf("expected currentSessionId 'sess-1', got %v", result.CurrentSessionID)
	}
}

func TestAgents_Start(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/agents/agent-1/start" {
			t.Errorf("expected path /api/agents/agent-1/start, got %s", r.URL.Path)
		}

		body, _ := io.ReadAll(r.Body)
		var parsed map[string]string
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("failed to parse request body: %v", err)
		}
		if parsed["taskId"] != "task-1" {
			t.Errorf("expected taskId 'task-1', got %q", parsed["taskId"])
		}

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Agents.Start(context.Background(), "agent-1", "task-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestAgents_Stop(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/agents/agent-1/stop" {
			t.Errorf("expected path /api/agents/agent-1/stop, got %s", r.URL.Path)
		}

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Agents.Stop(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestAgents_Pause(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/agents/agent-1/pause" {
			t.Errorf("expected path /api/agents/agent-1/pause, got %s", r.URL.Path)
		}

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Agents.Pause(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestAgents_Resume(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/agents/agent-1/resume" {
			t.Errorf("expected path /api/agents/agent-1/resume, got %s", r.URL.Path)
		}

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Agents.Resume(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}
