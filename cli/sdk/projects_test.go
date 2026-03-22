package sdk

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProjects_List(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/project-folders" {
			t.Errorf("expected path /api/project-folders, got %s", r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":        "proj-1",
					"name":      "Backend Services",
					"slug":      "backend-services",
					"icon":      "folder",
					"color":     "blue",
					"createdAt": "2025-01-01T00:00:00Z",
					"updatedAt": "2025-01-01T00:00:00Z",
				},
				{
					"id":          "proj-2",
					"name":        "Frontend Apps",
					"slug":        "frontend-apps",
					"description": "All frontend applications",
					"icon":        "code",
					"color":       "green",
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

	result, err := client.Projects.List(context.Background())
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 projects, got %d", len(result))
	}
	if result[0].ID != "proj-1" {
		t.Errorf("expected first project ID 'proj-1', got %q", result[0].ID)
	}
	if result[0].Name != "Backend Services" {
		t.Errorf("expected name 'Backend Services', got %q", result[0].Name)
	}
	if result[0].Slug != "backend-services" {
		t.Errorf("expected slug 'backend-services', got %q", result[0].Slug)
	}
	if result[0].Icon != "folder" {
		t.Errorf("expected icon 'folder', got %q", result[0].Icon)
	}
	if result[0].Color != "blue" {
		t.Errorf("expected color 'blue', got %q", result[0].Color)
	}
	if result[1].ID != "proj-2" {
		t.Errorf("expected second project ID 'proj-2', got %q", result[1].ID)
	}
	if result[1].Description == nil || *result[1].Description != "All frontend applications" {
		t.Errorf("expected description 'All frontend applications', got %v", result[1].Description)
	}
}

func TestProjects_List_Empty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

	result, err := client.Projects.List(context.Background())
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected 0 projects, got %d", len(result))
	}
}

func TestProjects_Get(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/project-folders/proj-1" {
			t.Errorf("expected path /api/project-folders/proj-1, got %s", r.URL.Path)
		}

		desc := "Main backend services"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "proj-1",
				"name":        "Backend Services",
				"slug":        "backend-services",
				"description": desc,
				"icon":        "folder",
				"color":       "blue",
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

	result, err := client.Projects.Get(context.Background(), "proj-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ID != "proj-1" {
		t.Errorf("expected ID 'proj-1', got %q", result.ID)
	}
	if result.Name != "Backend Services" {
		t.Errorf("expected name 'Backend Services', got %q", result.Name)
	}
	if result.Slug != "backend-services" {
		t.Errorf("expected slug 'backend-services', got %q", result.Slug)
	}
	if result.Description == nil || *result.Description != "Main backend services" {
		t.Errorf("expected description 'Main backend services', got %v", result.Description)
	}
	if result.Icon != "folder" {
		t.Errorf("expected icon 'folder', got %q", result.Icon)
	}
	if result.Color != "blue" {
		t.Errorf("expected color 'blue', got %q", result.Color)
	}
}

func TestProjects_Get_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "NOT_FOUND",
				"message": "Project folder not found",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Projects.Get(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsNotFound(err) {
		t.Errorf("expected IsNotFound to be true, got false (err: %v)", err)
	}
}

func TestProjects_Create(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/project-folders" {
			t.Errorf("expected path /api/project-folders, got %s", r.URL.Path)
		}

		body, _ := io.ReadAll(r.Body)
		var opts ProjectCreateOptions
		if err := json.Unmarshal(body, &opts); err != nil {
			t.Fatalf("failed to parse request body: %v", err)
		}
		if opts.Name != "New Project" {
			t.Errorf("expected name 'New Project', got %q", opts.Name)
		}
		if opts.Description == nil || *opts.Description != "A new project folder" {
			t.Errorf("expected description 'A new project folder', got %v", opts.Description)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":          "proj-new",
				"name":        "New Project",
				"slug":        "new-project",
				"description": "A new project folder",
				"icon":        "folder",
				"color":       "gray",
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

	desc := "A new project folder"
	result, err := client.Projects.Create(context.Background(), ProjectCreateOptions{
		Name:        "New Project",
		Description: &desc,
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ID != "proj-new" {
		t.Errorf("expected ID 'proj-new', got %q", result.ID)
	}
	if result.Name != "New Project" {
		t.Errorf("expected name 'New Project', got %q", result.Name)
	}
	if result.Slug != "new-project" {
		t.Errorf("expected slug 'new-project', got %q", result.Slug)
	}
	if result.Description == nil || *result.Description != "A new project folder" {
		t.Errorf("expected description 'A new project folder', got %v", result.Description)
	}
}

func TestProjects_Create_MinimalFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var opts ProjectCreateOptions
		if err := json.Unmarshal(body, &opts); err != nil {
			t.Fatalf("failed to parse request body: %v", err)
		}
		if opts.Name != "Minimal" {
			t.Errorf("expected name 'Minimal', got %q", opts.Name)
		}
		if opts.Description != nil {
			t.Errorf("expected nil description, got %v", opts.Description)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"id":        "proj-min",
				"name":      "Minimal",
				"slug":      "minimal",
				"icon":      "folder",
				"color":     "gray",
				"createdAt": "2025-01-01T00:00:00Z",
				"updatedAt": "2025-01-01T00:00:00Z",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Projects.Create(context.Background(), ProjectCreateOptions{
		Name: "Minimal",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ID != "proj-min" {
		t.Errorf("expected ID 'proj-min', got %q", result.ID)
	}
}

func TestProjects_Create_ValidationError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "VALIDATION_ERROR",
				"message": "Name is required",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Projects.Create(context.Background(), ProjectCreateOptions{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsValidationError(err) {
		t.Errorf("expected IsValidationError to be true, got false (err: %v)", err)
	}
}

func TestProjects_Delete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/api/project-folders/proj-1" {
			t.Errorf("expected path /api/project-folders/proj-1, got %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Projects.Delete(context.Background(), "proj-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestProjects_Delete_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "NOT_FOUND",
				"message": "Project folder not found",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Projects.Delete(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsNotFound(err) {
		t.Errorf("expected IsNotFound to be true, got false (err: %v)", err)
	}
}
