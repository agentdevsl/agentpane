package sdk

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWorktrees_List(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/worktrees" {
			t.Errorf("expected path /api/worktrees, got %s", r.URL.Path)
		}
		if r.URL.Query().Get("codespaceId") != "cs-1" {
			t.Errorf("expected codespaceId=cs-1, got %q", r.URL.Query().Get("codespaceId"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":          "wt-1",
					"codespaceId": "cs-1",
					"branch":      "feature/login",
					"path":        "/tmp/worktrees/wt-1",
					"baseBranch":  "main",
					"status":      "active",
					"createdAt":   "2025-01-01T00:00:00Z",
					"updatedAt":   "2025-01-01T00:00:00Z",
				},
				{
					"id":          "wt-2",
					"codespaceId": "cs-1",
					"agentId":     "agent-1",
					"taskId":      "task-1",
					"branch":      "feature/signup",
					"path":        "/tmp/worktrees/wt-2",
					"baseBranch":  "main",
					"status":      "active",
					"createdAt":   "2025-01-02T00:00:00Z",
					"updatedAt":   "2025-01-02T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Worktrees.List(context.Background(), "cs-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 worktrees, got %d", len(result))
	}
	if result[0].ID != "wt-1" {
		t.Errorf("expected first worktree ID 'wt-1', got %q", result[0].ID)
	}
	if result[0].Branch != "feature/login" {
		t.Errorf("expected branch 'feature/login', got %q", result[0].Branch)
	}
	if result[0].BaseBranch != "main" {
		t.Errorf("expected baseBranch 'main', got %q", result[0].BaseBranch)
	}
	if result[0].Status != "active" {
		t.Errorf("expected status 'active', got %q", result[0].Status)
	}
	if result[1].ID != "wt-2" {
		t.Errorf("expected second worktree ID 'wt-2', got %q", result[1].ID)
	}
	if result[1].AgentID == nil || *result[1].AgentID != "agent-1" {
		t.Errorf("expected agentId 'agent-1', got %v", result[1].AgentID)
	}
	if result[1].TaskID == nil || *result[1].TaskID != "task-1" {
		t.Errorf("expected taskId 'task-1', got %v", result[1].TaskID)
	}
}

func TestWorktrees_List_NoCodespaceFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" {
			t.Errorf("expected no query params, got %q", r.URL.RawQuery)
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

	result, err := client.Worktrees.List(context.Background(), "")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected 0 worktrees, got %d", len(result))
	}
}

func TestWorktrees_Get(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/worktrees/wt-1" {
			t.Errorf("expected path /api/worktrees/wt-1, got %s", r.URL.Path)
		}

		agentID := "agent-1"
		taskID := "task-1"
		mergedAt := "2025-01-05T00:00:00Z"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "wt-1",
				"codespaceId": "cs-1",
				"agentId":     agentID,
				"taskId":      taskID,
				"branch":      "feature/login",
				"path":        "/tmp/worktrees/wt-1",
				"baseBranch":  "main",
				"status":      "active",
				"createdAt":   "2025-01-01T00:00:00Z",
				"updatedAt":   "2025-01-01T00:00:00Z",
				"mergedAt":    mergedAt,
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Worktrees.Get(context.Background(), "wt-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ID != "wt-1" {
		t.Errorf("expected ID 'wt-1', got %q", result.ID)
	}
	if result.CodespaceID != "cs-1" {
		t.Errorf("expected codespaceId 'cs-1', got %q", result.CodespaceID)
	}
	if result.Branch != "feature/login" {
		t.Errorf("expected branch 'feature/login', got %q", result.Branch)
	}
	if result.Path != "/tmp/worktrees/wt-1" {
		t.Errorf("expected path '/tmp/worktrees/wt-1', got %q", result.Path)
	}
	if result.BaseBranch != "main" {
		t.Errorf("expected baseBranch 'main', got %q", result.BaseBranch)
	}
	if result.Status != "active" {
		t.Errorf("expected status 'active', got %q", result.Status)
	}
	if result.AgentID == nil || *result.AgentID != "agent-1" {
		t.Errorf("expected agentId 'agent-1', got %v", result.AgentID)
	}
	if result.TaskID == nil || *result.TaskID != "task-1" {
		t.Errorf("expected taskId 'task-1', got %v", result.TaskID)
	}
	if result.MergedAt == nil || *result.MergedAt != "2025-01-05T00:00:00Z" {
		t.Errorf("expected mergedAt '2025-01-05T00:00:00Z', got %v", result.MergedAt)
	}
}

func TestWorktrees_Get_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "NOT_FOUND",
				"message": "Worktree not found",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Worktrees.Get(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsNotFound(err) {
		t.Errorf("expected IsNotFound to be true, got false (err: %v)", err)
	}
}

func TestWorktrees_Delete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/api/worktrees/wt-1" {
			t.Errorf("expected path /api/worktrees/wt-1, got %s", r.URL.Path)
		}
		if r.URL.Query().Get("force") != "" {
			t.Errorf("expected no force param, got %q", r.URL.Query().Get("force"))
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Worktrees.Delete(context.Background(), "wt-1", false)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestWorktrees_Delete_WithForce(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/api/worktrees/wt-1" {
			t.Errorf("expected path /api/worktrees/wt-1, got %s", r.URL.Path)
		}
		if r.URL.Query().Get("force") != "true" {
			t.Errorf("expected force=true, got %q", r.URL.Query().Get("force"))
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Worktrees.Delete(context.Background(), "wt-1", true)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestWorktrees_Diff(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/worktrees/wt-1/diff" {
			t.Errorf("expected path /api/worktrees/wt-1/diff, got %s", r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"files": []map[string]interface{}{
					{
						"path":   "main.go",
						"status": "modified",
					},
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Worktrees.Diff(context.Background(), "wt-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
}

func TestWorktrees_Diff_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "NOT_FOUND",
				"message": "Worktree not found",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Worktrees.Diff(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsNotFound(err) {
		t.Errorf("expected IsNotFound to be true, got false (err: %v)", err)
	}
}

func TestWorktrees_Merge(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/worktrees/wt-1/merge" {
			t.Errorf("expected path /api/worktrees/wt-1/merge, got %s", r.URL.Path)
		}

		body, _ := io.ReadAll(r.Body)
		var opts WorktreeMergeOptions
		if err := json.Unmarshal(body, &opts); err != nil {
			t.Fatalf("failed to parse request body: %v", err)
		}
		if opts.TargetBranch != "main" {
			t.Errorf("expected targetBranch 'main', got %q", opts.TargetBranch)
		}
		if !opts.DeleteAfterMerge {
			t.Errorf("expected deleteAfterMerge true, got false")
		}

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Worktrees.Merge(context.Background(), "wt-1", WorktreeMergeOptions{
		TargetBranch:     "main",
		DeleteAfterMerge: true,
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestWorktrees_Merge_Conflict(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "CONFLICT",
				"message": "Merge conflict detected",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Worktrees.Merge(context.Background(), "wt-1", WorktreeMergeOptions{
		TargetBranch: "main",
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsConflict(err) {
		t.Errorf("expected IsConflict to be true, got false (err: %v)", err)
	}
}
