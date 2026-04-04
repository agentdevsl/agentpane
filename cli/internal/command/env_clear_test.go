package command

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEnvClearCommand_Run_Success(t *testing.T) {
	var putBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			json.Unmarshal(body, &putBody)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
			})
		default:
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"data": map[string]interface{}{
					"settings": map[string]interface{}{},
				},
			})
		}
	}))
	defer server.Close()

	cmd := &EnvClearCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}

	// Verify the PUT body sets an empty map.
	if putBody == nil {
		t.Fatal("expected PUT request to be made")
	}
	settings := putBody["settings"].(map[string]interface{})
	envVal := settings["sandbox.env"].(map[string]interface{})
	if len(envVal) != 0 {
		t.Errorf("expected empty map, got %v", envVal)
	}
}

func TestEnvClearCommand_Run_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":    false,
			"error": map[string]string{"code": "INTERNAL_ERROR", "message": "fail"},
		})
	}))
	defer server.Close()

	cmd := &EnvClearCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestEnvClearCommand_Synopsis(t *testing.T) {
	cmd := &EnvClearCommand{Meta: NewMeta()}
	if s := cmd.Synopsis(); s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestEnvClearCommand_Help(t *testing.T) {
	cmd := &EnvClearCommand{Meta: NewMeta()}
	if h := cmd.Help(); h == "" {
		t.Error("Help() returned empty string")
	}
}
