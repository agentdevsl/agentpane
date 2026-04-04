package sdk

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSettings_Get(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Path != "/api/settings" {
			t.Errorf("expected path /api/settings, got %s", r.URL.Path)
		}
		if keys := r.URL.Query().Get("keys"); keys != "sandbox.env" {
			t.Errorf("expected keys=sandbox.env, got %q", keys)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"settings": map[string]interface{}{
					"sandbox.env": map[string]string{
						"TFE_TOKEN":  "tfc-abc123",
						"AWS_REGION": "us-east-1",
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

	result, err := client.Settings.Get(context.Background(), "sandbox.env")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	envMap, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map[string]interface{}, got %T", result)
	}
	if envMap["TFE_TOKEN"] != "tfc-abc123" {
		t.Errorf("expected TFE_TOKEN=tfc-abc123, got %q", envMap["TFE_TOKEN"])
	}
	if envMap["AWS_REGION"] != "us-east-1" {
		t.Errorf("expected AWS_REGION=us-east-1, got %q", envMap["AWS_REGION"])
	}
}

func TestSettings_Get_KeyNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]interface{}{
				"settings": map[string]interface{}{},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	result, err := client.Settings.Get(context.Background(), "sandbox.env")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result != nil {
		t.Errorf("expected nil for missing key, got %v", result)
	}
}

func TestSettings_Get_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "INTERNAL_ERROR",
				"message": "Failed to get settings",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	_, err = client.Settings.Get(context.Background(), "sandbox.env")
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("expected status 500, got %d", apiErr.StatusCode)
	}
}

func TestSettings_Set(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("expected PUT, got %s", r.Method)
		}
		if r.URL.Path != "/api/settings" {
			t.Errorf("expected path /api/settings, got %s", r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("expected Content-Type application/json, got %q", ct)
		}

		body, _ := io.ReadAll(r.Body)
		var parsed settingsUpdateRequest
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("failed to parse request body: %v", err)
		}

		envVal, ok := parsed.Settings["sandbox.env"]
		if !ok {
			t.Fatal("expected sandbox.env key in settings")
		}
		envMap, ok := envVal.(map[string]interface{})
		if !ok {
			t.Fatalf("expected map for sandbox.env, got %T", envVal)
		}
		if envMap["TFE_TOKEN"] != "tfc-new" {
			t.Errorf("expected TFE_TOKEN=tfc-new, got %q", envMap["TFE_TOKEN"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Settings.Set(context.Background(), "sandbox.env", map[string]string{
		"TFE_TOKEN": "tfc-new",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestSettings_Set_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "INTERNAL_ERROR",
				"message": "Failed to update settings",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(Config{Address: server.URL, Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error creating client: %v", err)
	}

	err = client.Settings.Set(context.Background(), "sandbox.env", map[string]string{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("expected status 500, got %d", apiErr.StatusCode)
	}
}
