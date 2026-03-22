package sdk

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
)

// SessionService provides operations on session resources.
type SessionService struct {
	client *Client
}

// List returns sessions matching the given filter options.
func (s *SessionService) List(ctx context.Context, opts SessionListOptions) ([]Session, error) {
	params := url.Values{}
	if opts.CodespaceID != "" {
		params.Set("codespaceId", opts.CodespaceID)
	}
	if opts.Status != "" {
		params.Set("status", opts.Status)
	}
	if opts.AgentID != "" {
		params.Set("agentId", opts.AgentID)
	}
	if opts.Limit > 0 {
		params.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Offset > 0 {
		params.Set("offset", strconv.Itoa(opts.Offset))
	}

	path := "/api/sessions"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	var result []Session
	if err := s.client.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Get returns a single session by ID.
func (s *SessionService) Get(ctx context.Context, id string) (*Session, error) {
	var result Session
	if err := s.client.get(ctx, fmt.Sprintf("/api/sessions/%s", id), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetEvents returns the events for a session with optional pagination.
// Pass limit=0 and offset=0 for server defaults.
func (s *SessionService) GetEvents(ctx context.Context, id string, limit, offset int) ([]SessionEvent, error) {
	params := url.Values{}
	if limit > 0 {
		params.Set("limit", strconv.Itoa(limit))
	}
	if offset > 0 {
		params.Set("offset", strconv.Itoa(offset))
	}

	path := fmt.Sprintf("/api/sessions/%s/events", id)
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	var result []SessionEvent
	if err := s.client.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// GetSummary returns aggregated metrics for a session.
func (s *SessionService) GetSummary(ctx context.Context, id string) (*SessionSummary, error) {
	var result SessionSummary
	if err := s.client.get(ctx, fmt.Sprintf("/api/sessions/%s/summary", id), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Delete removes a session by ID.
func (s *SessionService) Delete(ctx context.Context, id string) error {
	return s.client.del(ctx, fmt.Sprintf("/api/sessions/%s", id))
}
