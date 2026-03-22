package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]string{
				"status":   "ok",
				"database": "connected",
			},
		})
	}))
	defer server.Close()

	cmd := &HealthCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestHealthCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": map[string]string{
				"status":   "ok",
				"database": "connected",
			},
		})
	}))
	defer server.Close()

	cmd := &HealthCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-json"})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestHealthCommand_Run_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "INTERNAL_ERROR",
				"message": "something went wrong",
			},
		})
	}))
	defer server.Close()

	cmd := &HealthCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestHealthCommand_Run_ConnectionRefused(t *testing.T) {
	// Point at an address where nothing is listening.
	cmd := &HealthCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://127.0.0.1:19999"})
	if code != 1 {
		t.Errorf("Run() on connection refused = %d, want 1", code)
	}
}

func TestHealthCommand_Synopsis(t *testing.T) {
	cmd := &HealthCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestHealthCommand_Help(t *testing.T) {
	cmd := &HealthCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
