package command

import (
	"context"
	"fmt"
	"os"
)

// TaskApproveCommand approves a pending agent plan for a task.
type TaskApproveCommand struct {
	*Meta
}

// Run executes the task approve command.
func (c *TaskApproveCommand) Run(args []string) int {
	flags := c.FlagSet("task approve")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	remaining := flags.Args()
	if len(remaining) != 1 {
		fmt.Fprintf(os.Stderr, "Error: exactly one task ID is required\n")
		return 1
	}
	taskID := remaining[0]

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	ctx := context.Background()
	if err := client.Tasks.ApprovePlan(ctx, taskID); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	fmt.Printf("Task %s plan approved\n", taskID)
	return 0
}

// Help returns detailed help text for the task approve command.
func (c *TaskApproveCommand) Help() string {
	return `Usage: agentpane task approve <task-id> [options]

  Approve the pending agent plan for a task. The agent will
  proceed to the execution phase.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
`
}

// Synopsis returns a one-line description of the task approve command.
func (c *TaskApproveCommand) Synopsis() string {
	return "Approve a pending task plan"
}
