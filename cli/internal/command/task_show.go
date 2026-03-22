package command

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/agentdevsl/agentpane/cli/internal/output"
)

// TaskShowCommand displays details for a single task.
type TaskShowCommand struct {
	*Meta
}

// Run executes the task show command.
func (c *TaskShowCommand) Run(args []string) int {
	flags := c.FlagSet("task show")
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
	task, err := client.Tasks.Get(ctx, taskID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(task)
		return 0
	}

	pairs := []output.KeyValue{
		{Key: "ID", Value: task.ID},
		{Key: "Codespace", Value: task.CodespaceID},
		{Key: "Title", Value: task.Title},
		{Key: "Column", Value: task.Column},
		{Key: "Priority", Value: task.Priority},
		{Key: "Labels", Value: strings.Join(task.Labels, ", ")},
		{Key: "Created", Value: task.CreatedAt},
		{Key: "Updated", Value: task.UpdatedAt},
	}

	if task.Description != nil {
		pairs = append(pairs, output.KeyValue{Key: "Description", Value: *task.Description})
	}
	if task.AgentID != nil {
		pairs = append(pairs, output.KeyValue{Key: "Agent ID", Value: *task.AgentID})
	}
	if task.SessionID != nil {
		pairs = append(pairs, output.KeyValue{Key: "Session ID", Value: *task.SessionID})
	}
	if task.WorktreeID != nil {
		pairs = append(pairs, output.KeyValue{Key: "Worktree ID", Value: *task.WorktreeID})
	}
	if task.Branch != nil {
		pairs = append(pairs, output.KeyValue{Key: "Branch", Value: *task.Branch})
	}
	if task.LastAgentStatus != nil {
		pairs = append(pairs, output.KeyValue{Key: "Agent Status", Value: *task.LastAgentStatus})
	}
	if task.Plan != nil {
		pairs = append(pairs, output.KeyValue{Key: "Plan", Value: *task.Plan})
	}

	output.PrintKeyValue(pairs)
	return 0
}

// Help returns detailed help text for the task show command.
func (c *TaskShowCommand) Help() string {
	return `Usage: agentpane task show <task-id> [options]

  Show details for a single task.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON
`
}

// Synopsis returns a one-line description of the task show command.
func (c *TaskShowCommand) Synopsis() string {
	return "Show task details"
}
