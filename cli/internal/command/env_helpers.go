package command

import (
	"context"
	"fmt"

	"github.com/agentdevsl/agentpane/cli/sdk"
)

// settingsKey is the settings API key for sandbox environment variables.
const settingsKey = "sandbox.env"

// getEnvMap retrieves the current sandbox.env setting as a map[string]string.
// Returns an empty map if the setting is not yet configured.
func getEnvMap(ctx context.Context, client *sdk.Client) (map[string]string, error) {
	raw, err := client.Settings.Get(ctx, settingsKey)
	if err != nil {
		return nil, err
	}

	if raw == nil {
		return map[string]string{}, nil
	}

	// The API returns interface{} — typically map[string]interface{} from JSON.
	rawMap, ok := raw.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected type for %s: %T", settingsKey, raw)
	}

	result := make(map[string]string, len(rawMap))
	for k, v := range rawMap {
		s, ok := v.(string)
		if !ok {
			s = fmt.Sprintf("%v", v)
		}
		result[k] = s
	}
	return result, nil
}

// maskValue masks a value for display, showing only the first 4 characters.
// Short values (4 chars or fewer) are fully masked.
func maskValue(v string) string {
	if len(v) <= 4 {
		return "****"
	}
	return v[:4] + "****"
}
