package command

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEnvDeleteCommand_Run_Success(t *testing.T) {
	var putBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodGet:
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
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			json.Unmarshal(body, &putBody)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
			})
		}
	}))
	defer server.Close()

	cmd := &EnvDeleteCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "TFE_TOKEN"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}

	// Verify the PUT body has TFE_TOKEN removed but AWS_REGION kept.
	if putBody == nil {
		t.Fatal("expected PUT request to be made")
	}
	settings := putBody["settings"].(map[string]interface{})
	envVal := settings["sandbox.env"].(map[string]interface{})
	if _, exists := envVal["TFE_TOKEN"]; exists {
		t.Error("expected TFE_TOKEN to be deleted")
	}
	if envVal["AWS_REGION"] != "us-east-1" {
		t.Errorf("expected AWS_REGION=us-east-1, got %v", envVal["AWS_REGION"])
	}
}

func TestEnvDeleteCommand_Run_KeyNotFound(t *testing.T) {
	server := newEnvServer(map[string]string{
		"EXISTING": "value",
	})
	defer server.Close()

	cmd := &EnvDeleteCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "NONEXISTENT"})
	if code != 1 {
		t.Errorf("Run() for nonexistent key = %d, want 1", code)
	}
}

func TestEnvDeleteCommand_Run_MissingArg(t *testing.T) {
	cmd := &EnvDeleteCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", "http://localhost:1"})
	if code != 1 {
		t.Errorf("Run() with no args = %d, want 1", code)
	}
}

func TestEnvDeleteCommand_Synopsis(t *testing.T) {
	cmd := &EnvDeleteCommand{Meta: NewMeta()}
	if s := cmd.Synopsis(); s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestEnvDeleteCommand_Help(t *testing.T) {
	cmd := &EnvDeleteCommand{Meta: NewMeta()}
	if h := cmd.Help(); h == "" {
		t.Error("Help() returned empty string")
	}
}
