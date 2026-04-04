package sdk

import (
	"context"
	"encoding/json"
	"fmt"
)

// SettingsService provides operations for managing application settings.
type SettingsService struct {
	client *Client
}

// settingsResponse matches the API response shape: { settings: { key: value } }.
type settingsResponse struct {
	Settings map[string]json.RawMessage `json:"settings"`
}

// settingsUpdateRequest matches the API request shape for PUT /api/settings.
type settingsUpdateRequest struct {
	Settings map[string]interface{} `json:"settings"`
}

// Get retrieves a single setting by key.
// The returned value is the raw JSON for that key, decoded into interface{}.
func (s *SettingsService) Get(ctx context.Context, key string) (interface{}, error) {
	path := fmt.Sprintf("/api/settings?keys=%s", key)

	var resp settingsResponse
	if err := s.client.get(ctx, path, &resp); err != nil {
		return nil, err
	}

	raw, ok := resp.Settings[key]
	if !ok {
		return nil, nil
	}

	var value interface{}
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("sdk: failed to decode setting %q: %w", key, err)
	}
	return value, nil
}

// Set updates a single setting key to the given value.
func (s *SettingsService) Set(ctx context.Context, key string, value interface{}) error {
	body := settingsUpdateRequest{
		Settings: map[string]interface{}{
			key: value,
		},
	}
	return s.client.put(ctx, "/api/settings", body, nil)
}
