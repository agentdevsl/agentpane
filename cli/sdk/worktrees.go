package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// WorktreeService provides operations on git worktree resources.
type WorktreeService struct {
	client *Client
}

// List returns all worktrees for a given codespace.
func (s *WorktreeService) List(ctx context.Context, codespaceID string) ([]Worktree, error) {
	params := url.Values{}
	if codespaceID != "" {
		params.Set("codespaceId", codespaceID)
	}

	path := "/api/worktrees"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	var result []Worktree
	if err := s.client.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Get returns a single worktree by ID.
func (s *WorktreeService) Get(ctx context.Context, id string) (*Worktree, error) {
	var result Worktree
	if err := s.client.get(ctx, fmt.Sprintf("/api/worktrees/%s", url.PathEscape(id)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Delete removes a worktree by ID. If force is true, the worktree
// is removed even if it has uncommitted changes.
func (s *WorktreeService) Delete(ctx context.Context, id string, force bool) error {
	path := fmt.Sprintf("/api/worktrees/%s", url.PathEscape(id))
	if force {
		path += "?force=true"
	}
	return s.client.del(ctx, path)
}

// Diff returns the diff of changes in a worktree relative to its base branch.
func (s *WorktreeService) Diff(ctx context.Context, id string) (interface{}, error) {
	var result interface{}
	if err := s.client.get(ctx, fmt.Sprintf("/api/worktrees/%s/diff", url.PathEscape(id)), &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Merge merges a worktree's branch into the target branch.
func (s *WorktreeService) Merge(ctx context.Context, id string, opts WorktreeMergeOptions) error {
	return s.client.post(ctx, fmt.Sprintf("/api/worktrees/%s/merge", url.PathEscape(id)), opts, nil)
}
