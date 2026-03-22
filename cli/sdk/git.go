package sdk

import (
	"context"
	"net/url"
	"strconv"
)

// GitService provides git operations for codespaces.
type GitService struct {
	client *Client
}

// Status returns the git working tree status for a codespace.
func (s *GitService) Status(ctx context.Context, codespaceID string) (interface{}, error) {
	params := url.Values{}
	if codespaceID != "" {
		params.Set("codespaceId", codespaceID)
	}

	path := "/api/git/status"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	var result interface{}
	if err := s.client.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Branches returns the list of git branches for a codespace.
func (s *GitService) Branches(ctx context.Context, codespaceID string) ([]GitBranch, error) {
	params := url.Values{}
	if codespaceID != "" {
		params.Set("codespaceId", codespaceID)
	}

	path := "/api/git/branches"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	var result []GitBranch
	if err := s.client.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Commits returns the commit history for a codespace, optionally filtered
// by branch name and limited to a maximum number of results.
func (s *GitService) Commits(ctx context.Context, codespaceID string, branch string, limit int) (interface{}, error) {
	params := url.Values{}
	if codespaceID != "" {
		params.Set("codespaceId", codespaceID)
	}
	if branch != "" {
		params.Set("branch", branch)
	}
	if limit > 0 {
		params.Set("limit", strconv.Itoa(limit))
	}

	path := "/api/git/commits"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	var result interface{}
	if err := s.client.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return result, nil
}
