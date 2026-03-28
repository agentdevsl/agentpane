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

// List returns all sessions matching the given filter options, automatically
// paginating through results.
func (s *SessionService) List(ctx context.Context, opts SessionListOptions) ([]Session, error) {
	var allSessions []Session
	offset := opts.Offset
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultPageSize
	}

	for page := 0; page < maxPages; page++ {
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
		params.Set("limit", strconv.Itoa(limit))
		params.Set("offset", strconv.Itoa(offset))

		path := "/api/sessions?" + params.Encode()

		items, pagination, err := getList[Session](s.client, ctx, path)
		if err != nil {
			return nil, err
		}

		allSessions = append(allSessions, items...)

		if len(items) == 0 || len(items) < limit {
			break
		}
		if pagination != nil && offset+len(items) >= pagination.Total {
			break
		}
		if pagination == nil {
			break
		}

		offset += len(items)
	}

	return allSessions, nil
}

// Get returns a single session by ID.
func (s *SessionService) Get(ctx context.Context, id string) (*Session, error) {
	var result Session
	if err := s.client.get(ctx, fmt.Sprintf("/api/sessions/%s", url.PathEscape(id)), &result); err != nil {
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

	path := fmt.Sprintf("/api/sessions/%s/events", url.PathEscape(id))
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
	if err := s.client.get(ctx, fmt.Sprintf("/api/sessions/%s/summary", url.PathEscape(id)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Delete removes a session by ID.
func (s *SessionService) Delete(ctx context.Context, id string) error {
	return s.client.del(ctx, fmt.Sprintf("/api/sessions/%s", url.PathEscape(id)))
}

// Export exports a session in the specified format (json, markdown, csv).
func (s *SessionService) Export(ctx context.Context, id string, format string) (*ExportResponse, error) {
	var result ExportResponse
	body := map[string]string{"format": format}
	if err := s.client.post(ctx, fmt.Sprintf("/api/sessions/%s/export", url.PathEscape(id)), body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
