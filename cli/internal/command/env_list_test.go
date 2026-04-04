package command

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newEnvServer(envVars map[string]string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/settings":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"data": map[string]interface{}{
					"settings": map[string]interface{}{
						"sandbox.env": envVars,
					},
				},
			})
		case r.Method == http.MethodPut && r.URL.Path == "/api/settings":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
			})
		default:
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": map[string]string{"code": "NOT_FOUND", "message": "not found"},
			})
		}
	}))
}

func TestEnvListCommand_Run_Success(t *testing.T) {
	server := newEnvServer(map[string]string{
		"TFE_TOKEN":  "tfc-abc123",
		"AWS_REGION": "us-east-1",
	})
	defer server.Close()

	cmd := &EnvListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestEnvListCommand_Run_Empty(t *testing.T) {
	server := newEnvServer(map[string]string{})
	defer server.Close()

	cmd := &EnvListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}
}

func TestEnvListCommand_Run_JSON(t *testing.T) {
	server := newEnvServer(map[string]string{
		"TFE_TOKEN": "tfc-abc123",
	})
	defer server.Close()

	cmd := &EnvListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "-json"})
	if code != 0 {
		t.Errorf("Run() with -json = %d, want 0", code)
	}
}

func TestEnvListCommand_Run_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":    false,
			"error": map[string]string{"code": "INTERNAL_ERROR", "message": "fail"},
		})
	}))
	defer server.Close()

	cmd := &EnvListCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL})
	if code != 1 {
		t.Errorf("Run() on server error = %d, want 1", code)
	}
}

func TestEnvListCommand_Synopsis(t *testing.T) {
	cmd := &EnvListCommand{Meta: NewMeta()}
	if s := cmd.Synopsis(); s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestEnvListCommand_Help(t *testing.T) {
	cmd := &EnvListCommand{Meta: NewMeta()}
	if h := cmd.Help(); h == "" {
		t.Error("Help() returned empty string")
	}
}
