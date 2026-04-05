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

// defaultPageSize is the number of items fetched per page when auto-paginating.
const defaultPageSize = 100

// maxPages prevents infinite pagination loops.
const maxPages = 100

// List returns all tasks matching the given filter options, automatically
// paginating through all results. At minimum, CodespaceID should be provided.
func (s *TaskService) List(ctx context.Context, opts TaskListOptions) ([]Task, error) {
	var allTasks []Task
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
		if opts.Column != "" {
			params.Set("column", opts.Column)
		}
		params.Set("limit", strconv.Itoa(limit))
		params.Set("offset", strconv.Itoa(offset))

		path := "/api/tasks?" + params.Encode()

		items, pagination, err := getList[Task](s.client, ctx, path)
		if err != nil {
			return nil, err
		}

		allTasks = append(allTasks, items...)

		// Stop if no items returned or fewer than requested
		if len(items) == 0 || len(items) < limit {
			break
		}
		// Stop if pagination says we have all results
		if pagination != nil && offset+len(items) >= pagination.Total {
			break
		}
		// If no pagination metadata, we got a flat array — no more pages
		if pagination == nil {
			break
		}

		offset += len(items)
	}

	return allTasks, nil
}

// Get returns a single task by ID.
func (s *TaskService) Get(ctx context.Context, id string) (*Task, error) {
	var result Task
	if err := s.client.get(ctx, fmt.Sprintf("/api/tasks/%s", url.PathEscape(id)), &result); err != nil {
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
	if err := s.client.put(ctx, fmt.Sprintf("/api/tasks/%s", url.PathEscape(id)), opts, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Delete removes a task by ID.
func (s *TaskService) Delete(ctx context.Context, id string) error {
	return s.client.del(ctx, fmt.Sprintf("/api/tasks/%s", url.PathEscape(id)))
}

// taskMoveResponse wraps the move API response which nests the task.
type taskMoveResponse struct {
	Task       Task    `json:"task"`
	AgentError *string `json:"agentError,omitempty"`
}

// Move changes a task's column and/or position on the board.
// Moving a task to "in_progress" triggers automatic agent assignment.
func (s *TaskService) Move(ctx context.Context, id string, opts TaskMoveOptions) (*Task, error) {
	var result taskMoveResponse
	if err := s.client.patch(ctx, fmt.Sprintf("/api/tasks/%s/move", url.PathEscape(id)), opts, &result); err != nil {
		return nil, err
	}
	if result.AgentError != nil {
		return &result.Task, fmt.Errorf("agent start failed: %s", *result.AgentError)
	}
	return &result.Task, nil
}

// ApprovePlan approves the agent's plan for a task, triggering execution.
func (s *TaskService) ApprovePlan(ctx context.Context, id string) error {
	return s.client.post(ctx, fmt.Sprintf("/api/tasks/%s/approve-plan", url.PathEscape(id)), nil, nil)
}

// RejectPlan rejects the agent's plan for a task with an optional reason.
func (s *TaskService) RejectPlan(ctx context.Context, id string, reason string) error {
	body := map[string]string{}
	if reason != "" {
		body["reason"] = reason
	}
	return s.client.post(ctx, fmt.Sprintf("/api/tasks/%s/reject-plan", url.PathEscape(id)), body, nil)
}

// StopAgent stops the agent currently working on a task.
func (s *TaskService) StopAgent(ctx context.Context, id string) error {
	return s.client.post(ctx, fmt.Sprintf("/api/tasks/%s/stop-agent", url.PathEscape(id)), nil, nil)
}
