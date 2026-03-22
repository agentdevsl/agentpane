package sdk

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTeams_List(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/teams" {
			t.Errorf("expected path /api/teams, got %s", r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":          "team-1",
					"name":        "Backend Team",
					"slug":        "backend-team",
					"description": "Handles backend services",
					"createdAt":   "2025-01-01T00:00:00Z",
					"updatedAt":   "2025-01-01T00:00:00Z",
				},
				{
					"id":        "team-2",
					"name":      "Frontend Team",
					"slug":      "frontend-team",
					"createdAt": "2025-01-02T00:00:00Z",
					"updatedAt": "2025-01-02T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Teams.List(context.Background())
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 teams, got %d", len(result))
	}
	if result[0].ID != "team-1" {
		t.Errorf("expected first team ID 'team-1', got %q", result[0].ID)
	}
	if result[0].Name != "Backend Team" {
		t.Errorf("expected name 'Backend Team', got %q", result[0].Name)
	}
	if result[0].Slug != "backend-team" {
		t.Errorf("expected slug 'backend-team', got %q", result[0].Slug)
	}
	if result[0].Description == nil || *result[0].Description != "Handles backend services" {
		t.Errorf("expected description 'Handles backend services', got %v", result[0].Description)
	}
	if result[1].ID != "team-2" {
		t.Errorf("expected second team ID 'team-2', got %q", result[1].ID)
	}
	if result[1].Name != "Frontend Team" {
		t.Errorf("expected name 'Frontend Team', got %q", result[1].Name)
	}
	if result[1].Slug != "frontend-team" {
		t.Errorf("expected slug 'frontend-team', got %q", result[1].Slug)
	}
	if result[1].Description != nil {
		t.Errorf("expected nil description for team-2, got %v", result[1].Description)
	}
}

func TestTeams_List_Empty(t *testing.T) {
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

	result, err := client.Teams.List(context.Background())
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected 0 teams, got %d", len(result))
	}
}

func TestTeams_List_Unauthorized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "UNAUTHORIZED",
				"message": "Invalid or missing token",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "bad-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Teams.List(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsUnauthorized(err) {
		t.Errorf("expected IsUnauthorized to be true, got false (err: %v)", err)
	}
}

func TestTeams_List_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "INTERNAL_ERROR",
				"message": "Something went wrong",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Teams.List(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("expected status code 500, got %d", apiErr.StatusCode)
	}
	if apiErr.Code != "INTERNAL_ERROR" {
		t.Errorf("expected code 'INTERNAL_ERROR', got %q", apiErr.Code)
	}
}
