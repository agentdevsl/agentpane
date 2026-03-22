package command

import (
	"context"
	"fmt"
	"os"
)

// TaskRejectCommand rejects a pending agent plan for a task.
type TaskRejectCommand struct {
	*Meta
}

// Run executes the task reject command.
func (c *TaskRejectCommand) Run(args []string) int {
	var reason string

	flags := c.FlagSet("task reject")
	flags.StringVar(&reason, "reason", "", "Rejection reason")
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
	if err := client.Tasks.RejectPlan(ctx, taskID, reason); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	fmt.Printf("Task %s plan rejected\n", taskID)
	return 0
}

// Help returns detailed help text for the task reject command.
func (c *TaskRejectCommand) Help() string {
	return `Usage: agentpane task reject <task-id> [options]

  Reject the pending agent plan for a task. The agent may
  revise the plan based on feedback.

Options:

  -reason=<text>    Rejection reason
  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
`
}

// Synopsis returns a one-line description of the task reject command.
func (c *TaskRejectCommand) Synopsis() string {
	return "Reject a pending task plan"
}
