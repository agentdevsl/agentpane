package command

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/agentdevsl/agentpane/cli/sdk"
)

// Default wait settings.
const (
	DefaultWaitTimeout  = 5 * time.Minute
	DefaultWaitInterval = 2 * time.Second
	minWaitInterval     = 100 * time.Millisecond
)

// WaitForTask polls the task until it reaches a terminal state, the timeout
// expires, or the context is cancelled.
// Terminal columns: waiting_approval, verified.
// Terminal agent statuses: completed (returns nil error), error (returns error).
// Progress updates are printed to stderr.
func WaitForTask(ctx context.Context, client *sdk.Client, taskID string, timeout, interval time.Duration) (*sdk.Task, error) {
	if interval < minWaitInterval {
		interval = DefaultWaitInterval
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	for {
		task, err := client.Tasks.Get(ctx, taskID)
		if err != nil {
			if ctx.Err() != nil {
				return nil, fmt.Errorf("timed out after %s waiting for task %s", timeout, taskID)
			}
			return nil, fmt.Errorf("failed to poll task: %w", err)
		}

		// Check terminal column states.
		switch task.Column {
		case sdk.ColumnWaitingApproval, sdk.ColumnVerified:
			return task, nil
		}

		// Check terminal agent statuses.
		agentStatus := "none"
		if task.LastAgentStatus != nil {
			agentStatus = *task.LastAgentStatus
		}

		switch agentStatus {
		case sdk.AgentStatusCompleted:
			return task, nil
		case sdk.AgentStatusError:
			return task, fmt.Errorf("agent terminated with error status for task %s", taskID)
		}

		fmt.Fprintf(os.Stderr, "Waiting... column: %s, agent: %s\n", task.Column, agentStatus)

		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("timed out after %s waiting for task %s", timeout, taskID)
		case <-time.After(interval):
		}
	}
}
