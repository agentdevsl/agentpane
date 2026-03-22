package sdk

import (
	"context"
	"fmt"
)

// FolderService provides operations on project folder resources.
type FolderService struct {
	client *Client
}

// List returns all project folders.
func (s *FolderService) List(ctx context.Context) ([]ProjectFolder, error) {
	var result []ProjectFolder
	if err := s.client.get(ctx, "/api/project-folders", &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Get returns a single project folder by ID.
func (s *FolderService) Get(ctx context.Context, id string) (*ProjectFolder, error) {
	var result ProjectFolder
	if err := s.client.get(ctx, fmt.Sprintf("/api/project-folders/%s", id), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Create creates a new project folder.
func (s *FolderService) Create(ctx context.Context, opts FolderCreateOptions) (*ProjectFolder, error) {
	var result ProjectFolder
	if err := s.client.post(ctx, "/api/project-folders", opts, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Delete removes a project folder.
func (s *FolderService) Delete(ctx context.Context, id string) error {
	return s.client.del(ctx, fmt.Sprintf("/api/project-folders/%s", id))
}
