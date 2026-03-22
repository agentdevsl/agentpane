package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTaskRejectCommand_Run_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tasks/task-1/reject-plan" {
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

	cmd := &TaskRejectCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "task-1"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestTaskRejectCommand_Run_MissingID(t *testing.T) {
	cmd := &TaskRejectCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999"})
	if code != 1 {
		t.Errorf("Run() without ID = %d, want 1", code)
	}
}

func TestTaskRejectCommand_Run_WithReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["reason"] != "Plan is too complex" {
			t.Errorf("request reason = %v, want %q", body["reason"], "Plan is too complex")
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
		})
	}))
	defer server.Close()

	cmd := &TaskRejectCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "-reason", "Plan is too complex", "task-1"})
	if code != 0 {
		t.Errorf("Run() with -reason = %d, want 0", code)
	}
}

func TestTaskRejectCommand_Run_ServerError(t *testing.T) {
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

	cmd := &TaskRejectCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "test-token", "nonexistent"})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestTaskRejectCommand_Run_VerifiesRequestPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/api/tasks/my-task-id/reject-plan"
		if r.URL.Path != expected {
			t.Errorf("path = %q, want %q", r.URL.Path, expected)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
		})
	}))
	defer server.Close()

	cmd := &TaskRejectCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-token", "tok", "my-task-id"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestTaskRejectCommand_Run_TooManyArgs(t *testing.T) {
	cmd := &TaskRejectCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:9999", "task-1", "extra"})
	if code != 1 {
		t.Errorf("Run() with too many args = %d, want 1", code)
	}
}

func TestTaskRejectCommand_Synopsis(t *testing.T) {
	cmd := &TaskRejectCommand{Meta: NewMeta()}
	s := cmd.Synopsis()
	if s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestTaskRejectCommand_Help(t *testing.T) {
	cmd := &TaskRejectCommand{Meta: NewMeta()}
	h := cmd.Help()
	if h == "" {
		t.Error("Help() returned empty string")
	}
}
