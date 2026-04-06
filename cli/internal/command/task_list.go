package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// TaskListCommand lists tasks within a codespace.
type TaskListCommand struct {
	*Meta
}

// Run executes the task list command.
func (c *TaskListCommand) Run(args []string) int {
	var column string
	var limit int

	flags := c.FlagSet("task list")
	flags.StringVar(&column, "column", "", "Filter by column (backlog, queued, in_progress, waiting_approval, verified)")
	flags.IntVar(&limit, "limit", 50, "Maximum number of tasks to return")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	codespaceID, err := c.ResolveCodespaceID(client)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	opts := sdk.TaskListOptions{
		CodespaceID: codespaceID,
		Column:      column,
		Limit:       limit,
	}

	ctx := context.Background()
	tasks, err := client.Tasks.List(ctx, opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(tasks)
		return 0
	}

	if len(tasks) == 0 {
		fmt.Println("No tasks found.")
		return 0
	}

	headers := []string{"ID", "Title", "Column", "Priority", "Agent Status"}
	rows := make([][]string, len(tasks))
	for i, t := range tasks {
		agentStatus := "-"
		if t.LastAgentStatus != nil {
			agentStatus = *t.LastAgentStatus
		}
		rows[i] = []string{t.ID, t.Title, t.Column, t.Priority, agentStatus}
	}

	output.PrintTable(headers, rows)
	return 0
}

// Help returns detailed help text for the task list command.
func (c *TaskListCommand) Help() string {
	return `Usage: agentpane task list [options]

  List tasks within a codespace.

Required Flags:

  -codespace=<id>   Codespace ID (env: AP_CODESPACE)

Optional Flags:

  -column=<name>    Filter by column
  -limit=<n>        Maximum results (default: 50)

Global Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON
`
}

// Synopsis returns a one-line description of the task list command.
func (c *TaskListCommand) Synopsis() string {
	return "List tasks in a codespace"
}
