package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// TaskRunCommand starts execution of a task by moving it to in_progress.
// This is a convenience shortcut for `task move <id> in_progress`.
type TaskRunCommand struct {
	*Meta
}

// Run executes the task run command.
func (c *TaskRunCommand) Run(args []string) int {
	flags := c.FlagSet("task run")
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

	opts := sdk.TaskMoveOptions{
		Column:   "in_progress",
		Position: 0,
	}

	ctx := context.Background()
	task, err := client.Tasks.Move(ctx, taskID, opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(task)
		return 0
	}

	fmt.Printf("Task %s moved to in_progress\n", task.ID)
	if task.AgentID != nil {
		fmt.Printf("Agent assigned: %s\n", *task.AgentID)
	}
	return 0
}

// Help returns detailed help text for the task run command.
func (c *TaskRunCommand) Help() string {
	return `Usage: agentpane task run <task-id> [options]

  Start a task by moving it to in_progress. An agent will be
  automatically assigned to begin working on the task.

  This is a shortcut for: agentpane task move <task-id> in_progress

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON
`
}

// Synopsis returns a one-line description of the task run command.
func (c *TaskRunCommand) Synopsis() string {
	return "Start a task (move to in_progress)"
}
