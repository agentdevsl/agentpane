package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
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
	if client.Settings == nil {
		t.Error("expected Settings service to be initialized")
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

// --- getList tests ---

// testItem is a simple struct used to exercise the generic getList helper.
type testItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func TestGetList_PaginatedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"items": []map[string]string{
					{"id": "a", "name": "Alpha"},
					{"id": "b", "name": "Bravo"},
				},
				"pagination": map[string]int{
					"total":  2,
					"limit":  100,
					"offset": 0,
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "tok"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	items, pag, err := getList[testItem](client, context.Background(), "/api/things")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	if items[0].ID != "a" || items[0].Name != "Alpha" {
		t.Errorf("unexpected first item: %+v", items[0])
	}
	if items[1].ID != "b" || items[1].Name != "Bravo" {
		t.Errorf("unexpected second item: %+v", items[1])
	}
	if pag == nil {
		t.Fatal("expected pagination to be non-nil")
	}
	if pag.Total != 2 {
		t.Errorf("expected total=2, got %d", pag.Total)
	}
	if pag.Limit != 100 {
		t.Errorf("expected limit=100, got %d", pag.Limit)
	}
	if pag.Offset != 0 {
		t.Errorf("expected offset=0, got %d", pag.Offset)
	}
}

func TestGetList_FlatArrayResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]string{
				{"id": "x", "name": "X-ray"},
				{"id": "y", "name": "Yankee"},
				{"id": "z", "name": "Zulu"},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "tok"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	items, pag, err := getList[testItem](client, context.Background(), "/api/things")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("expected 3 items, got %d", len(items))
	}
	if items[0].ID != "x" {
		t.Errorf("expected first id 'x', got %q", items[0].ID)
	}
	if items[2].Name != "Zulu" {
		t.Errorf("expected third name 'Zulu', got %q", items[2].Name)
	}
	if pag != nil {
		t.Errorf("expected nil pagination for flat array, got %+v", pag)
	}
}

func TestGetList_EmptyPaginatedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"items": []interface{}{},
				"pagination": map[string]int{
					"total":  0,
					"limit":  100,
					"offset": 0,
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "tok"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	items, pag, err := getList[testItem](client, context.Background(), "/api/things")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(items) != 0 {
		t.Errorf("expected 0 items, got %d", len(items))
	}
	if pag == nil {
		t.Fatal("expected pagination metadata even for empty result")
	}
	if pag.Total != 0 {
		t.Errorf("expected total=0, got %d", pag.Total)
	}
}

func TestGetList_ErrorResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "INTERNAL_ERROR",
				"message": "something broke",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "tok"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	items, pag, err := getList[testItem](client, context.Background(), "/api/things")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if items != nil {
		t.Errorf("expected nil items on error, got %v", items)
	}
	if pag != nil {
		t.Errorf("expected nil pagination on error, got %v", pag)
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("expected status 500, got %d", apiErr.StatusCode)
	}
	if apiErr.Code != "INTERNAL_ERROR" {
		t.Errorf("expected code INTERNAL_ERROR, got %q", apiErr.Code)
	}
}

func TestGetList_MultiPagePagination(t *testing.T) {
	// Simulates a server that returns 2 items per page with total=5.
	// The Tasks.List auto-pagination loop should fetch all 3 pages.
	var requestCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := atomic.AddInt32(&requestCount, 1)
		w.Header().Set("Content-Type", "application/json")

		var items []map[string]interface{}
		offset := 0
		switch page {
		case 1:
			offset = 0
			items = []map[string]interface{}{
				{"id": "t1", "codespaceId": "cs", "title": "Task 1", "column": "backlog", "position": 0, "priority": "low", "labels": []string{}, "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-01T00:00:00Z"},
				{"id": "t2", "codespaceId": "cs", "title": "Task 2", "column": "backlog", "position": 1, "priority": "low", "labels": []string{}, "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-01T00:00:00Z"},
			}
		case 2:
			offset = 2
			items = []map[string]interface{}{
				{"id": "t3", "codespaceId": "cs", "title": "Task 3", "column": "backlog", "position": 2, "priority": "low", "labels": []string{}, "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-01T00:00:00Z"},
				{"id": "t4", "codespaceId": "cs", "title": "Task 4", "column": "backlog", "position": 3, "priority": "low", "labels": []string{}, "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-01T00:00:00Z"},
			}
		case 3:
			offset = 4
			items = []map[string]interface{}{
				{"id": "t5", "codespaceId": "cs", "title": "Task 5", "column": "backlog", "position": 4, "priority": "low", "labels": []string{}, "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-01T00:00:00Z"},
			}
		default:
			t.Errorf("unexpected request page %d", page)
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"items": items,
				"pagination": map[string]int{
					"total":  5,
					"limit":  2,
					"offset": offset,
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "tok"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	tasks, err := client.Tasks.List(context.Background(), TaskListOptions{
		CodespaceID: "cs",
		Limit:       2,
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(tasks) != 5 {
		t.Fatalf("expected 5 tasks across 3 pages, got %d", len(tasks))
	}
	for i, task := range tasks {
		want := fmt.Sprintf("t%d", i+1)
		if task.ID != want {
			t.Errorf("task[%d]: expected ID %q, got %q", i, want, task.ID)
		}
	}
	if atomic.LoadInt32(&requestCount) != 3 {
		t.Errorf("expected 3 HTTP requests for multi-page, got %d", atomic.LoadInt32(&requestCount))
	}
}
