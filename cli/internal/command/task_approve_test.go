package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTaskApproveCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tasks/task-1/approve-plan" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method: %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
		})
	}))
	defer server.Close()

	cmd := &TaskApproveCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "task-1"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestTaskApproveCommand_Run_MissingID(t *testing.T) {
	cmd := &TaskApproveCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() without ID = %d, want 1", code)
	}
}

func TestTaskApproveCommand_Run_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false,
			"error": map[string]string{
				"code":    "NOT_FOUND",
				"message": "task not found",
			},
		})
	}))
	defer server.Close()

	cmd := &TaskApproveCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "nonexistent"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestTaskApproveCommand_Run_VerifiesRequestPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/api/tasks/my-task-id/approve-plan"
		if r.URL.Path != expected {
			t.Errorf("path = %q, want %q", r.URL.Path, expected)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
		})
	}))
	defer server.Close()

	cmd := &TaskApproveCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "tok", "my-task-id"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestTaskApproveCommand_Run_TooManyArgs(t *testing.T) {
	cmd := &TaskApproveCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999", "task-1", "extra"})
	if code != 1 {
		t.Errorf("Run() with too many args = %d, want 1", code)
	}
}

func TestTaskApproveCommand_Synopsis(t *testing.T) {
	cmd := &TaskApproveCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestTaskApproveCommand_Help(t *testing.T) {
	cmd := &TaskApproveCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
