package sdk

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCodespaces_List(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/codespaces" {
			t.Errorf("expected path /api/codespaces, got %s", r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":                  "cs-1",
					"projectFolderId":     "folder-1",
					"name":                "My Codespace",
					"path":                "/home/user/project",
					"maxConcurrentAgents": 3,
					"createdAt":           "2025-01-01T00:00:00Z",
					"updatedAt":           "2025-01-01T00:00:00Z",
				},
				{
					"id":                  "cs-2",
					"projectFolderId":     "folder-1",
					"name":                "Another Codespace",
					"path":                "/home/user/other",
					"maxConcurrentAgents": 1,
					"createdAt":           "2025-01-02T00:00:00Z",
					"updatedAt":           "2025-01-02T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Codespaces.List(context.Background())
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 codespaces, got %d", len(result))
	}
	if result[0].ID != "cs-1" {
		t.Errorf("expected first codespace ID 'cs-1', got %q", result[0].ID)
	}
	if result[0].Name != "My Codespace" {
		t.Errorf("expected name 'My Codespace', got %q", result[0].Name)
	}
	if result[1].ID != "cs-2" {
		t.Errorf("expected second codespace ID 'cs-2', got %q", result[1].ID)
	}
}

func TestCodespaces_Get(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/codespaces/cs-1" {
			t.Errorf("expected path /api/codespaces/cs-1, got %s", r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":                  "cs-1",
				"projectFolderId":     "folder-1",
				"name":                "My Codespace",
				"path":                "/home/user/project",
				"description":         "A test codespace",
				"maxConcurrentAgents": 3,
				"githubOwner":         "agentpane",
				"githubRepo":          "nocode",
				"createdAt":           "2025-01-01T00:00:00Z",
				"updatedAt":           "2025-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Codespaces.Get(context.Background(), "cs-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ID != "cs-1" {
		t.Errorf("expected ID 'cs-1', got %q", result.ID)
	}
	if result.Name != "My Codespace" {
		t.Errorf("expected name 'My Codespace', got %q", result.Name)
	}
	if result.Description == nil || *result.Description != "A test codespace" {
		t.Errorf("expected description 'A test codespace', got %v", result.Description)
	}
	if result.GithubOwner == nil || *result.GithubOwner != "agentpane" {
		t.Errorf("expected githubOwner 'agentpane', got %v", result.GithubOwner)
	}
	if result.MaxConcurrentAgents != 3 {
		t.Errorf("expected maxConcurrentAgents 3, got %d", result.MaxConcurrentAgents)
	}
}

func TestCodespaces_Get_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "NOT_FOUND",
				"message": "Codespace not found",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Codespaces.Get(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsNotFound(err) {
		t.Errorf("expected IsNotFound to be true, got false (err: %v)", err)
	}
}

func TestCodespaces_Create(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/codespaces" {
			t.Errorf("expected path /api/codespaces, got %s", r.URL.Path)
		}

		body, _ := io.ReadAll(r.Body)
		var opts CodespaceCreateOptions
		if err := json.Unmarshal(body, &opts); err != nil {
			t.Fatalf("failed to parse request body: %v", err)
		}
		if opts.Name != "New CS" {
			t.Errorf("expected name 'New CS', got %q", opts.Name)
		}
		if opts.Path != "/tmp/project" {
			t.Errorf("expected path '/tmp/project', got %q", opts.Path)
		}
		if opts.ProjectID != "folder-1" {
			t.Errorf("expected folderID 'folder-1', got %q", opts.ProjectID)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":                  "cs-new",
				"projectFolderId":     "folder-1",
				"name":                "New CS",
				"path":                "/tmp/project",
				"maxConcurrentAgents": 1,
				"createdAt":           "2025-01-01T00:00:00Z",
				"updatedAt":           "2025-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Codespaces.Create(context.Background(), CodespaceCreateOptions{
		Name:     "New CS",
		Path:     "/tmp/project",
		ProjectID: "folder-1",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ID != "cs-new" {
		t.Errorf("expected ID 'cs-new', got %q", result.ID)
	}
	if result.Name != "New CS" {
		t.Errorf("expected name 'New CS', got %q", result.Name)
	}
}

func TestCodespaces_Delete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/api/codespaces/cs-1" {
			t.Errorf("expected path /api/codespaces/cs-1, got %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Codespaces.Delete(context.Background(), "cs-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}
