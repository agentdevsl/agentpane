package sdk

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTasks_List_WithCodespaceFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if !strings.HasPrefix(r.URL.Path, "/api/tasks") {
			t.Errorf("expected path /api/tasks, got %s", r.URL.Path)
		}
		if r.URL.Query().Get("codespaceId") != "cs-1" {
			t.Errorf("expected codespaceId=cs-1, got %q", r.URL.Query().Get("codespaceId"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":          "task-1",
					"codespaceId": "cs-1",
					"title":       "Fix bug",
					"column":      "backlog",
					"position":    0,
					"priority":    "high",
					"labels":      []string{"bug"},
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

	result, err := client.Tasks.List(context.Background(), TaskListOptions{
		CodespaceID: "cs-1",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 task, got %d", len(result))
	}
	if result[0].ID != "task-1" {
		t.Errorf("expected task ID 'task-1', got %q", result[0].ID)
	}
	if result[0].Title != "Fix bug" {
		t.Errorf("expected title 'Fix bug', got %q", result[0].Title)
	}
	if result[0].Column != "backlog" {
		t.Errorf("expected column 'backlog', got %q", result[0].Column)
	}
	if result[0].Priority != "high" {
		t.Errorf("expected priority 'high', got %q", result[0].Priority)
	}
}

func TestTasks_List_WithColumnFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("column") != "in_progress" {
			t.Errorf("expected column=in_progress, got %q", r.URL.Query().Get("column"))
		}
		if r.URL.Query().Get("codespaceId") != "cs-1" {
			t.Errorf("expected codespaceId=cs-1, got %q", r.URL.Query().Get("codespaceId"))
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

	result, err := client.Tasks.List(context.Background(), TaskListOptions{
		CodespaceID: "cs-1",
		Column:      "in_progress",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected 0 tasks, got %d", len(result))
	}
}

func TestTasks_List_WithPagination(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "10" {
			t.Errorf("expected limit=10, got %q", r.URL.Query().Get("limit"))
		}
		if r.URL.Query().Get("offset") != "20" {
			t.Errorf("expected offset=20, got %q", r.URL.Query().Get("offset"))
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

	_, err = client.Tasks.List(context.Background(), TaskListOptions{
		CodespaceID: "cs-1",
		Limit:       10,
		Offset:      20,
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestTasks_Get(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/tasks/task-1" {
			t.Errorf("expected path /api/tasks/task-1, got %s", r.URL.Path)
		}

		agentID := "agent-1"
		sessionID := "sess-1"
		desc := "Detailed task description"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "task-1",
				"codespaceId": "cs-1",
				"title":       "Fix bug",
				"description": desc,
				"column":      "in_progress",
				"position":    1,
				"priority":    "high",
				"labels":      []string{"bug", "urgent"},
				"agentId":     agentID,
				"sessionId":   sessionID,
				"createdAt":   "2025-01-01T00:00:00Z",
				"updatedAt":   "2025-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Tasks.Get(context.Background(), "task-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ID != "task-1" {
		t.Errorf("expected ID 'task-1', got %q", result.ID)
	}
	if result.Column != "in_progress" {
		t.Errorf("expected column 'in_progress', got %q", result.Column)
	}
	if result.Description == nil || *result.Description != "Detailed task description" {
		t.Errorf("expected description, got %v", result.Description)
	}
	if result.AgentID == nil || *result.AgentID != "agent-1" {
		t.Errorf("expected agentId 'agent-1', got %v", result.AgentID)
	}
	if result.SessionID == nil || *result.SessionID != "sess-1" {
		t.Errorf("expected sessionId 'sess-1', got %v", result.SessionID)
	}
	if len(result.Labels) != 2 {
		t.Errorf("expected 2 labels, got %d", len(result.Labels))
	}
}

func TestTasks_Create(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/tasks" {
			t.Errorf("expected path /api/tasks, got %s", r.URL.Path)
		}

		body, _ := io.ReadAll(r.Body)
		var opts TaskCreateOptions
		if err := json.Unmarshal(body, &opts); err != nil {
			t.Fatalf("failed to parse request body: %v", err)
		}
		if opts.CodespaceID != "cs-1" {
			t.Errorf("expected codespaceId 'cs-1', got %q", opts.CodespaceID)
		}
		if opts.Title != "New Task" {
			t.Errorf("expected title 'New Task', got %q", opts.Title)
		}
		if opts.Priority != "medium" {
			t.Errorf("expected priority 'medium', got %q", opts.Priority)
		}
		if len(opts.Labels) != 1 || opts.Labels[0] != "feature" {
			t.Errorf("expected labels [feature], got %v", opts.Labels)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "task-new",
				"codespaceId": "cs-1",
				"title":       "New Task",
				"column":      "backlog",
				"position":    0,
				"priority":    "medium",
				"labels":      []string{"feature"},
				"createdAt":   "2025-01-01T00:00:00Z",
				"updatedAt":   "2025-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Tasks.Create(context.Background(), TaskCreateOptions{
		CodespaceID: "cs-1",
		Title:       "New Task",
		Priority:    "medium",
		Labels:      []string{"feature"},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ID != "task-new" {
		t.Errorf("expected ID 'task-new', got %q", result.ID)
	}
	if result.Column != "backlog" {
		t.Errorf("expected column 'backlog', got %q", result.Column)
	}
}

func TestTasks_Move(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("expected PATCH, got %s", r.Method)
		}
		if r.URL.Path != "/api/tasks/task-1/move" {
			t.Errorf("expected path /api/tasks/task-1/move, got %s", r.URL.Path)
		}

		body, _ := io.ReadAll(r.Body)
		var opts TaskMoveOptions
		if err := json.Unmarshal(body, &opts); err != nil {
			t.Fatalf("failed to parse request body: %v", err)
		}
		if opts.Column != "in_progress" {
			t.Errorf("expected column 'in_progress', got %q", opts.Column)
		}
		if opts.Position != 2 {
			t.Errorf("expected position 2, got %d", opts.Position)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"task": map[string]interface{}{
					"id":          "task-1",
					"codespaceId": "cs-1",
					"title":       "Fix bug",
					"column":      "in_progress",
					"position":    2,
					"priority":    "high",
					"labels":      []string{},
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

	result, err := client.Tasks.Move(context.Background(), "task-1", TaskMoveOptions{
		Column:   "in_progress",
		Position: 2,
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.Column != "in_progress" {
		t.Errorf("expected column 'in_progress', got %q", result.Column)
	}
	if result.Position != 2 {
		t.Errorf("expected position 2, got %d", result.Position)
	}
}

func TestTasks_ApprovePlan(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/tasks/task-1/approve-plan" {
			t.Errorf("expected path /api/tasks/task-1/approve-plan, got %s", r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Tasks.ApprovePlan(context.Background(), "task-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestTasks_RejectPlan(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/tasks/task-1/reject-plan" {
			t.Errorf("expected path /api/tasks/task-1/reject-plan, got %s", r.URL.Path)
		}

		body, _ := io.ReadAll(r.Body)
		var parsed map[string]string
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("failed to parse request body: %v", err)
		}
		if parsed["reason"] != "Plan is too complex" {
			t.Errorf("expected reason 'Plan is too complex', got %q", parsed["reason"])
		}

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Tasks.RejectPlan(context.Background(), "task-1", "Plan is too complex")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestTasks_RejectPlan_EmptyReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var parsed map[string]string
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("failed to parse request body: %v", err)
		}
		if _, exists := parsed["reason"]; exists {
			t.Errorf("expected no 'reason' key for empty reason, but found one")
		}

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Tasks.RejectPlan(context.Background(), "task-1", "")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestTasks_StopAgent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/tasks/task-1/stop-agent" {
			t.Errorf("expected path /api/tasks/task-1/stop-agent, got %s", r.URL.Path)
		}

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Tasks.StopAgent(context.Background(), "task-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}
