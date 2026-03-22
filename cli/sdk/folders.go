package sdk

import (
	"context"
	"fmt"
)

// ProjectService provides operations on project resources.
type ProjectService struct {
	client *Client
}

// List returns all projects.
func (s *ProjectService) List(ctx context.Context) ([]Project, error) {
	var result []Project
	if err := s.client.get(ctx, "/api/project-folders", &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Get returns a single project by ID.
func (s *ProjectService) Get(ctx context.Context, id string) (*Project, error) {
	var result Project
	if err := s.client.get(ctx, fmt.Sprintf("/api/project-folders/%s", id), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Create creates a new project.
func (s *ProjectService) Create(ctx context.Context, opts ProjectCreateOptions) (*Project, error) {
	var result Project
	if err := s.client.post(ctx, "/api/project-folders", opts, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Delete removes a project.
func (s *ProjectService) Delete(ctx context.Context, id string) error {
	return s.client.del(ctx, fmt.Sprintf("/api/project-folders/%s", id))
}
