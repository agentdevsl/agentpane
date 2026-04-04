package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// CodespaceService provides operations on codespace resources.
type CodespaceService struct {
	client *Client
}

// List returns all codespaces.
func (s *CodespaceService) List(ctx context.Context) ([]Codespace, error) {
	items, _, err := getList[Codespace](s.client, ctx, "/api/codespaces")
	if err != nil {
		return nil, err
	}
	return items, nil
}

// Get returns a single codespace by ID.
func (s *CodespaceService) Get(ctx context.Context, id string) (*Codespace, error) {
	var result Codespace
	if err := s.client.get(ctx, fmt.Sprintf("/api/codespaces/%s", url.PathEscape(id)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Create creates a new codespace with the given options.
func (s *CodespaceService) Create(ctx context.Context, opts CodespaceCreateOptions) (*Codespace, error) {
	var result Codespace
	if err := s.client.post(ctx, "/api/codespaces", opts, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Update modifies a codespace.
func (s *CodespaceService) Update(ctx context.Context, id string, opts CodespaceUpdateOptions) (*Codespace, error) {
	var result Codespace
	if err := s.client.patch(ctx, fmt.Sprintf("/api/codespaces/%s", url.PathEscape(id)), opts, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Delete removes a codespace by ID.
func (s *CodespaceService) Delete(ctx context.Context, id string) error {
	return s.client.del(ctx, fmt.Sprintf("/api/codespaces/%s", url.PathEscape(id)))
}
