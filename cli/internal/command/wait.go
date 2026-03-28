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
)

// WaitForTask polls the task until it reaches a terminal state or the timeout expires.
// Terminal conditions: column changes to waiting_approval or verified,
// or agent status becomes completed or error.
// Progress updates are printed to stderr.
func WaitForTask(ctx context.Context, client *sdk.Client, taskID string, timeout, interval time.Duration) (*sdk.Task, error) {
	deadline := time.Now().Add(timeout)

	for {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("timed out after %s waiting for task %s", timeout, taskID)
		}

		task, err := client.Tasks.Get(ctx, taskID)
		if err != nil {
			return nil, fmt.Errorf("failed to poll task: %w", err)
		}

		// Check terminal column states.
		switch task.Column {
		case sdk.ColumnWaitingApproval, sdk.ColumnVerified:
			return task, nil
		}

		// Check terminal agent statuses.
		if task.LastAgentStatus != nil {
			switch *task.LastAgentStatus {
			case sdk.AgentStatusCompleted, sdk.AgentStatusError:
				return task, nil
			}
		}

		// Print progress to stderr.
		agentStatus := "none"
		if task.LastAgentStatus != nil {
			agentStatus = *task.LastAgentStatus
		}
		fmt.Fprintf(os.Stderr, "Waiting... column: %s, agent: %s\n", task.Column, agentStatus)

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(interval):
		}
	}
}
