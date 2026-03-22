package command

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// TaskCreateCommand creates a new task in a codespace.
type TaskCreateCommand struct {
	*Meta
}

// Run executes the task create command.
func (c *TaskCreateCommand) Run(args []string) int {
	var title, description, priority, labels string

	flags := c.FlagSet("task create")
	flags.StringVar(&title, "title", "", "Task title (required)")
	flags.StringVar(&description, "description", "", "Task description")
	flags.StringVar(&priority, "priority", "medium", "Priority: high, medium, low")
	flags.StringVar(&labels, "labels", "", "Comma-separated labels")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	codespaceID := c.CodespaceID()
	if codespaceID == "" {
		fmt.Fprintf(os.Stderr, "Error: -codespace is required (or set AP_CODESPACE)\n")
		return 1
	}
	if title == "" {
		fmt.Fprintf(os.Stderr, "Error: -title is required\n")
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	opts := sdk.TaskCreateOptions{
		CodespaceID: codespaceID,
		Title:       title,
		Priority:    priority,
	}
	if description != "" {
		opts.Description = &description
	}
	if labels != "" {
		opts.Labels = strings.Split(labels, ",")
		for i := range opts.Labels {
			opts.Labels[i] = strings.TrimSpace(opts.Labels[i])
		}
	}

	ctx := context.Background()
	task, err := client.Tasks.Create(ctx, opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(task)
		return 0
	}

	fmt.Printf("Task created: %s\n", task.ID)
	output.PrintKeyValue([]output.KeyValue{
		{Key: "ID", Value: task.ID},
		{Key: "Title", Value: task.Title},
		{Key: "Column", Value: task.Column},
		{Key: "Priority", Value: task.Priority},
	})
	return 0
}

// Help returns detailed help text for the task create command.
func (c *TaskCreateCommand) Help() string {
	return `Usage: agentpane task create [options]

  Create a new task in a codespace.

Required Flags:

  -codespace=<id>     Codespace ID (env: AP_CODESPACE)
  -title=<title>      Task title

Optional Flags:

  -description=<d>    Task description
  -priority=<p>       Priority: high, medium, low (default: medium)
  -labels=<l1,l2>     Comma-separated labels

Global Options:

  -address=<url>      API base URL (env: AP_ADDRESS)
  -token=<token>      API token (env: AP_TOKEN)
  -json               Output as JSON
`
}

// Synopsis returns a one-line description of the task create command.
func (c *TaskCreateCommand) Synopsis() string {
	return "Create a new task"
}
