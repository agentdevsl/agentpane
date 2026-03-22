package sdk

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
)

// TaskService provides operations on task resources.
type TaskService struct {
	client *Client
}

// List returns tasks matching the given filter options.
// At minimum, CodespaceID should be provided.
func (s *TaskService) List(ctx context.Context, opts TaskListOptions) ([]Task, error) {
	params := url.Values{}
	if opts.CodespaceID != "" {
		params.Set("codespaceId", opts.CodespaceID)
	}
	if opts.Column != "" {
		params.Set("column", opts.Column)
	}
	if opts.Limit > 0 {
		params.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Offset > 0 {
		params.Set("offset", strconv.Itoa(opts.Offset))
	}

	path := "/api/tasks"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	var result []Task
	if err := s.client.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Get returns a single task by ID.
func (s *TaskService) Get(ctx context.Context, id string) (*Task, error) {
	var result Task
	if err := s.client.get(ctx, fmt.Sprintf("/api/tasks/%s", id), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Create creates a new task with the given options.
func (s *TaskService) Create(ctx context.Context, opts TaskCreateOptions) (*Task, error) {
	var result Task
	if err := s.client.post(ctx, "/api/tasks", opts, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Update modifies an existing task by ID.
func (s *TaskService) Update(ctx context.Context, id string, opts TaskUpdateOptions) (*Task, error) {
	var result Task
	if err := s.client.put(ctx, fmt.Sprintf("/api/tasks/%s", id), opts, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Delete removes a task by ID.
func (s *TaskService) Delete(ctx context.Context, id string) error {
	return s.client.del(ctx, fmt.Sprintf("/api/tasks/%s", id))
}

// Move changes a task's column and/or position on the board.
// Moving a task to "in_progress" triggers automatic agent assignment.
func (s *TaskService) Move(ctx context.Context, id string, opts TaskMoveOptions) (*Task, error) {
	var result Task
	if err := s.client.patch(ctx, fmt.Sprintf("/api/tasks/%s/move", id), opts, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ApprovePlan approves the agent's plan for a task, triggering execution.
func (s *TaskService) ApprovePlan(ctx context.Context, id string) error {
	return s.client.post(ctx, fmt.Sprintf("/api/tasks/%s/approve-plan", id), nil, nil)
}

// RejectPlan rejects the agent's plan for a task with an optional reason.
func (s *TaskService) RejectPlan(ctx context.Context, id string, reason string) error {
	body := map[string]string{}
	if reason != "" {
		body["reason"] = reason
	}
	return s.client.post(ctx, fmt.Sprintf("/api/tasks/%s/reject-plan", id), body, nil)
}

// StopAgent stops the agent currently working on a task.
func (s *TaskService) StopAgent(ctx context.Context, id string) error {
	return s.client.post(ctx, fmt.Sprintf("/api/tasks/%s/stop-agent", id), nil, nil)
}
