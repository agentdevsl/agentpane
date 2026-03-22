package sdk

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewClient_ValidConfig(t *testing.T) {
	client, err := NewClient(Config{
		Address: "http://localhost:3001",
		Token:   "test-token",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if client == nil {
		t.Fatal("expected client to be non-nil")
	}
	if client.Codespaces == nil {
		t.Error("expected Codespaces service to be initialized")
	}
	if client.Tasks == nil {
		t.Error("expected Tasks service to be initialized")
	}
	if client.Agents == nil {
		t.Error("expected Agents service to be initialized")
	}
	if client.Sessions == nil {
		t.Error("expected Sessions service to be initialized")
	}
	if client.Worktrees == nil {
		t.Error("expected Worktrees service to be initialized")
	}
	if client.Projects == nil {
		t.Error("expected Projects service to be initialized")
	}
	if client.Teams == nil {
		t.Error("expected Teams service to be initialized")
	}
	if client.Git == nil {
		t.Error("expected Git service to be initialized")
	}
	if client.Health == nil {
		t.Error("expected Health service to be initialized")
	}
}

func TestNewClient_MissingAddress(t *testing.T) {
	_, err := NewClient(Config{Token: "test-token"})
	if err == nil {
		t.Fatal("expected error for missing address, got nil")
	}
	want := "sdk: address is required"
	if err.Error() != want {
		t.Errorf("expected error %q, got %q", want, err.Error())
	}
}

func TestNewClient_EmptyToken(t *testing.T) {
	client, err := NewClient(Config{Address: "http://localhost:3001"})
	if err != nil {
		t.Fatalf("expected no error for empty token, got %v", err)
	}
	if client == nil {
		t.Fatal("expected client to be non-nil")
	}
}

func TestNewClient_TrailingSlashNormalized(t *testing.T) {
	client, err := NewClient(Config{Address: "http://localhost:3001/"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client.config.Address != "http://localhost:3001" {
		t.Errorf("expected trailing slash to be removed, got %q", client.config.Address)
	}
}

func TestNewClient_DefaultUserAgent(t *testing.T) {
	client, err := NewClient(Config{Address: "http://localhost:3001"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client.config.UserAgent != "agentpane-go-sdk/1.0" {
		t.Errorf("expected default user agent, got %q", client.config.UserAgent)
	}
}

func TestNewClient_CustomUserAgent(t *testing.T) {
	client, err := NewClient(Config{
		Address:   "http://localhost:3001",
		UserAgent: "custom-agent/2.0",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client.config.UserAgent != "custom-agent/2.0" {
		t.Errorf("expected custom user agent, got %q", client.config.UserAgent)
	}
}

func TestDo_SuccessResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/test" {
			t.Errorf("expected path /api/test, got %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("expected Bearer token header, got %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Accept") != "application/json" {
			t.Errorf("expected Accept application/json, got %q", r.Header.Get("Accept"))
		}
		if r.Header.Get("User-Agent") != "agentpane-go-sdk/1.0" {
			t.Errorf("expected default User-Agent, got %q", r.Header.Get("User-Agent"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": map[string]string{"name": "test-value"},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	var result map[string]string
	err = client.get(context.Background(), "/api/test", &result)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result["name"] != "test-value" {
		t.Errorf("expected name=test-value, got %q", result["name"])
	}
}

func TestDo_ErrorResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "NOT_FOUND",
				"message": "Resource not found",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	var result map[string]string
	err = client.get(context.Background(), "/api/test", &result)
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 404 {
		t.Errorf("expected status 404, got %d", apiErr.StatusCode)
	}
	if apiErr.Code != "NOT_FOUND" {
		t.Errorf("expected code NOT_FOUND, got %q", apiErr.Code)
	}
	if apiErr.Message != "Resource not found" {
		t.Errorf("expected message 'Resource not found', got %q", apiErr.Message)
	}
}

func TestDo_NonJSONErrorResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("Bad Gateway"))
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	var result map[string]string
	err = client.get(context.Background(), "/api/test", &result)
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 502 {
		t.Errorf("expected status 502, got %d", apiErr.StatusCode)
	}
	if apiErr.Message != "Bad Gateway" {
		t.Errorf("expected message 'Bad Gateway', got %q", apiErr.Message)
	}
}

func TestDo_NoAuthHeaderWhenTokenEmpty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "" {
			t.Errorf("expected no Authorization header, got %q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": map[string]string{},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	var result map[string]string
	err = client.get(context.Background(), "/api/test", &result)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestDo_PostSendsContentType(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("expected Content-Type application/json, got %q", ct)
		}

		body, _ := io.ReadAll(r.Body)
		var parsed map[string]string
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("failed to parse body: %v", err)
		}
		if parsed["key"] != "value" {
			t.Errorf("expected body key=value, got %q", parsed["key"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": map[string]string{"id": "created"},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	var result map[string]string
	err = client.post(context.Background(), "/api/test", map[string]string{"key": "value"}, &result)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result["id"] != "created" {
		t.Errorf("expected id=created, got %q", result["id"])
	}
}

func TestDo_204NoContent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.del(context.Background(), "/api/test/123")
	if err != nil {
		t.Fatalf("expected no error for 204, got %v", err)
	}
}

func TestDo_OKFalseWith200(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "VALIDATION_ERROR",
				"message": "Invalid input",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	var result map[string]string
	err = client.get(context.Background(), "/api/test", &result)
	if err == nil {
		t.Fatal("expected error for ok=false, got nil")
	}

	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.Code != "VALIDATION_ERROR" {
		t.Errorf("expected code VALIDATION_ERROR, got %q", apiErr.Code)
	}
}
