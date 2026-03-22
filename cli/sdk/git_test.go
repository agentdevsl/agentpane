package sdk

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGit_Status(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/git/status" {
			t.Errorf("expected path /api/git/status, got %s", r.URL.Path)
		}
		if r.URL.Query().Get("codespaceId") != "cs-1" {
			t.Errorf("expected codespaceId=cs-1, got %q", r.URL.Query().Get("codespaceId"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"branch":   "main",
				"clean":    true,
				"files":    []interface{}{},
				"ahead":    0,
				"behind":   0,
				"tracking": "origin/main",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Git.Status(context.Background(), "cs-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	// Status returns interface{}, verify the map structure
	data, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	if data["branch"] != "main" {
		t.Errorf("expected branch 'main', got %v", data["branch"])
	}
	if data["clean"] != true {
		t.Errorf("expected clean true, got %v", data["clean"])
	}
	if data["tracking"] != "origin/main" {
		t.Errorf("expected tracking 'origin/main', got %v", data["tracking"])
	}
}

func TestGit_Status_NoCodespaceFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" {
			t.Errorf("expected no query params, got %q", r.URL.RawQuery)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"branch": "main",
				"clean":  true,
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Git.Status(context.Background(), "")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestGit_Status_Error(t *testing.T) {
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

	_, err = client.Git.Status(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsNotFound(err) {
		t.Errorf("expected IsNotFound to be true, got false (err: %v)", err)
	}
}

func TestGit_Branches(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/git/branches" {
			t.Errorf("expected path /api/git/branches, got %s", r.URL.Path)
		}
		if r.URL.Query().Get("codespaceId") != "cs-1" {
			t.Errorf("expected codespaceId=cs-1, got %q", r.URL.Query().Get("codespaceId"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"name":    "main",
					"current": true,
				},
				{
					"name":    "feature/login",
					"current": false,
				},
				{
					"name":    "fix/typo",
					"current": false,
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Git.Branches(context.Background(), "cs-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 3 {
		t.Fatalf("expected 3 branches, got %d", len(result))
	}
	if result[0].Name != "main" {
		t.Errorf("expected first branch name 'main', got %q", result[0].Name)
	}
	if !result[0].Current {
		t.Errorf("expected first branch to be current")
	}
	if result[1].Name != "feature/login" {
		t.Errorf("expected second branch name 'feature/login', got %q", result[1].Name)
	}
	if result[1].Current {
		t.Errorf("expected second branch to not be current")
	}
	if result[2].Name != "fix/typo" {
		t.Errorf("expected third branch name 'fix/typo', got %q", result[2].Name)
	}
}

func TestGit_Branches_NoCodespaceFilter(t *testing.T) {
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

	result, err := client.Git.Branches(context.Background(), "")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected 0 branches, got %d", len(result))
	}
}

func TestGit_Branches_Error(t *testing.T) {
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

	_, err = client.Git.Branches(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsNotFound(err) {
		t.Errorf("expected IsNotFound to be true, got false (err: %v)", err)
	}
}

func TestGit_Commits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/git/commits" {
			t.Errorf("expected path /api/git/commits, got %s", r.URL.Path)
		}
		if r.URL.Query().Get("codespaceId") != "cs-1" {
			t.Errorf("expected codespaceId=cs-1, got %q", r.URL.Query().Get("codespaceId"))
		}
		if r.URL.Query().Get("branch") != "main" {
			t.Errorf("expected branch=main, got %q", r.URL.Query().Get("branch"))
		}
		if r.URL.Query().Get("limit") != "10" {
			t.Errorf("expected limit=10, got %q", r.URL.Query().Get("limit"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"hash":    "abc123",
					"message": "Initial commit",
					"author":  "John Doe",
					"date":    "2025-01-01T00:00:00Z",
				},
				{
					"hash":    "def456",
					"message": "Add feature",
					"author":  "Jane Smith",
					"date":    "2025-01-02T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Git.Commits(context.Background(), "cs-1", "main", 10)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	// Commits returns interface{}, verify the slice structure
	data, ok := result.([]interface{})
	if !ok {
		t.Fatalf("expected slice result, got %T", result)
	}
	if len(data) != 2 {
		t.Fatalf("expected 2 commits, got %d", len(data))
	}
	first, ok := data[0].(map[string]interface{})
	if !ok {
		t.Fatalf("expected map for first commit, got %T", data[0])
	}
	if first["hash"] != "abc123" {
		t.Errorf("expected hash 'abc123', got %v", first["hash"])
	}
	if first["message"] != "Initial commit" {
		t.Errorf("expected message 'Initial commit', got %v", first["message"])
	}
	if first["author"] != "John Doe" {
		t.Errorf("expected author 'John Doe', got %v", first["author"])
	}
}

func TestGit_Commits_MinimalParams(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("codespaceId") != "cs-1" {
			t.Errorf("expected codespaceId=cs-1, got %q", r.URL.Query().Get("codespaceId"))
		}
		// branch and limit should not be set
		if r.URL.Query().Get("branch") != "" {
			t.Errorf("expected no branch param, got %q", r.URL.Query().Get("branch"))
		}
		if r.URL.Query().Get("limit") != "" {
			t.Errorf("expected no limit param, got %q", r.URL.Query().Get("limit"))
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

	_, err = client.Git.Commits(context.Background(), "cs-1", "", 0)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestGit_Commits_NoParams(t *testing.T) {
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

	_, err = client.Git.Commits(context.Background(), "", "", 0)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestGit_Commits_Error(t *testing.T) {
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

	_, err = client.Git.Commits(context.Background(), "nonexistent", "", 0)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsNotFound(err) {
		t.Errorf("expected IsNotFound to be true, got false (err: %v)", err)
	}
}
