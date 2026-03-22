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

// List returns all tasks matching the given filter options, automatically
// paginating through all results. At minimum, CodespaceID should be provided.
func (s *TaskService) List(ctx context.Context, opts TaskListOptions) ([]Task, error) {
	var allTasks []Task
	offset := opts.Offset
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultPageSize
	}

	for {
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

		var page ListResponse[Task]
		if err := s.client.get(ctx, path, &page); err != nil {
			// Fallback: try as flat array (some endpoints return flat arrays)
			var flat []Task
			if flatErr := s.client.get(ctx, path, &flat); flatErr == nil {
				return flat, nil
			}
			return nil, err
		}

		allTasks = append(allTasks, page.Items...)

		// If we got fewer items than requested, we've reached the end
		if len(page.Items) < limit {
			break
		}
		// If pagination info says we have all items, stop
		if page.Pagination != nil && offset+len(page.Items) >= page.Pagination.Total {
			break
		}

		offset += len(page.Items)
	}

	return allTasks, nil
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
