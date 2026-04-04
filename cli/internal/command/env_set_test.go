package command

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEnvSetCommand_Run_Success(t *testing.T) {
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
							"EXISTING": "value1",
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

	cmd := &EnvSetCommand{Meta: NewMeta()}
	code := cmd.Run([]string{"-address", server.URL, "NEW_KEY", "new_value"})
	if code != 0 {
		t.Errorf("Run() = %d, want 0", code)
	}

	// Verify the PUT body contains both old and new keys.
	if putBody == nil {
		t.Fatal("expected PUT request to be made")
	}
	settings, ok := putBody["settings"].(map[string]interface{})
	if !ok {
		t.Fatal("expected settings in PUT body")
	}
	envVal, ok := settings["sandbox.env"].(map[string]interface{})
	if !ok {
		t.Fatal("expected sandbox.env in PUT body settings")
	}
	if envVal["EXISTING"] != "value1" {
		t.Errorf("expected EXISTING=value1, got %v", envVal["EXISTING"])
	}
	if envVal["NEW_KEY"] != "new_value" {
		t.Errorf("expected NEW_KEY=new_value, got %v", envVal["NEW_KEY"])
	}
}

func TestEnvSetCommand_Run_MissingArgs(t *testing.T) {
	cmd := &EnvSetCommand{Meta: NewMeta()}

	// No args at all.
	code := cmd.Run([]string{"-address", "http://localhost:1"})
	if code != 1 {
		t.Errorf("Run() with no args = %d, want 1", code)
	}

	// Only KEY, no VALUE.
	code = cmd.Run([]string{"-address", "http://localhost:1", "KEY_ONLY"})
	if code != 1 {
		t.Errorf("Run() with only KEY = %d, want 1", code)
	}
}

func TestEnvSetCommand_Synopsis(t *testing.T) {
	cmd := &EnvSetCommand{Meta: NewMeta()}
	if s := cmd.Synopsis(); s == "" {
		t.Error("Synopsis() returned empty string")
	}
}

func TestEnvSetCommand_Help(t *testing.T) {
	cmd := &EnvSetCommand{Meta: NewMeta()}
	if h := cmd.Help(); h == "" {
		t.Error("Help() returned empty string")
	}
}
