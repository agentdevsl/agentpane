package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProjectListCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/project-folders" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":        "proj-1",
					"name":      "My Project",
					"slug":      "my-project",
					"icon":      "folder",
					"color":     "blue",
					"createdAt": "2026-01-01T00:00:00Z",
					"updatedAt": "2026-01-01T00:00:00Z",
				},
				{
					"id":        "proj-2",
					"name":      "Another",
					"slug":      "another",
					"icon":      "star",
					"color":     "green",
					"createdAt": "2026-01-02T00:00:00Z",
					"updatedAt": "2026-01-02T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	cmd := &ProjectListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestProjectListCommand_Run_Empty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":   true,
			"data": []interface{}{},
		})
	}))
	defer server.Close()

	cmd := &ProjectListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token"})
	if code != 0 {
		t.Errorf("Run() with empty list = %d, want 0", code)
	}
}

func TestProjectListCommand_Run_JSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"data": []map[string]interface{}{
				{
					"id":        "proj-1",
					"name":      "My Project",
					"slug":      "my-project",
					"icon":      "folder",
					"color":     "blue",
					"createdAt": "2026-01-01T00:00:00Z",
					"updatedAt": "2026-01-01T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()

	cmd := &ProjectListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-json"})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestProjectListCommand_Run_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "INTERNAL_ERROR",
				"message": "database down",
			},
		})
	}))
	defer server.Close()

	cmd := &ProjectListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestProjectListCommand_Synopsis(t *testing.T) {
	cmd := &ProjectListCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestProjectListCommand_Help(t *testing.T) {
	cmd := &ProjectListCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
