package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// AgentService provides operations on agent resources.
type AgentService struct {
	client *Client
}

// List returns all agents for a given codespace.
func (s *AgentService) List(ctx context.Context, codespaceID string) ([]Agent, error) {
	params := url.Values{}
	if codespaceID != "" {
		params.Set("codespaceId", codespaceID)
	}

	path := "/api/agents"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	var result []Agent
	if err := s.client.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Get returns a single agent by ID.
func (s *AgentService) Get(ctx context.Context, id string) (*Agent, error) {
	var result Agent
	if err := s.client.get(ctx, fmt.Sprintf("/api/agents/%s", url.PathEscape(id)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Start begins agent execution on the specified task.
func (s *AgentService) Start(ctx context.Context, id string, taskID string) error {
	body := map[string]string{
		"taskId": taskID,
	}
	return s.client.post(ctx, fmt.Sprintf("/api/agents/%s/start", id), body, nil)
}

// Stop halts agent execution.
func (s *AgentService) Stop(ctx context.Context, id string) error {
	return s.client.post(ctx, fmt.Sprintf("/api/agents/%s/stop", id), nil, nil)
}

// Pause temporarily suspends agent execution.
func (s *AgentService) Pause(ctx context.Context, id string) error {
	return s.client.post(ctx, fmt.Sprintf("/api/agents/%s/pause", id), nil, nil)
}

// Resume continues a paused agent's execution.
func (s *AgentService) Resume(ctx context.Context, id string) error {
	return s.client.post(ctx, fmt.Sprintf("/api/agents/%s/resume", id), nil, nil)
}
