package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// validColumns defines the allowed task columns.
var validColumns = map[string]bool{
	"backlog":          true,
	"queued":           true,
	"in_progress":      true,
	"waiting_approval": true,
	"verified":         true,
}

// TaskMoveCommand moves a task to a different column.
type TaskMoveCommand struct {
	*Meta
}

// Run executes the task move command.
func (c *TaskMoveCommand) Run(args []string) int {
	flags := c.FlagSet("task move")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	remaining := flags.Args()
	if len(remaining) != 2 {
		fmt.Fprintf(os.Stderr, "Error: usage: agentpane task move <task-id> <column>\n")
		return 1
	}

	taskID := remaining[0]
	column := remaining[1]

	if !validColumns[column] {
		fmt.Fprintf(os.Stderr, "Error: invalid column %q. Valid columns: backlog, queued, in_progress, waiting_approval, verified\n", column)
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	opts := sdk.TaskMoveOptions{
		Column:   column,
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

	fmt.Printf("Task %s moved to %s\n", task.ID, task.Column)
	return 0
}

// Help returns detailed help text for the task move command.
func (c *TaskMoveCommand) Help() string {
	return `Usage: agentpane task move <task-id> <column> [options]

  Move a task to a different column.

  Valid columns: backlog, queued, in_progress, waiting_approval, verified

  Moving to in_progress will auto-start an agent for the task.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON
`
}

// Synopsis returns a one-line description of the task move command.
func (c *TaskMoveCommand) Synopsis() string {
	return "Move a task to a different column"
}
