package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// SessionListCommand lists sessions within a codespace.
type SessionListCommand struct {
	*Meta
}

// Run executes the session list command.
func (c *SessionListCommand) Run(args []string) int {
	var status string
	var limit int

	flags := c.FlagSet("session list")
	flags.StringVar(&status, "status", "", "Filter by status (idle, initializing, active, paused, closing, closed, error)")
	flags.IntVar(&limit, "limit", 50, "Maximum number of sessions to return")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	codespaceID := c.CodespaceID()
	if codespaceID == "" {
		fmt.Fprintf(os.Stderr, "Error: -codespace is required (or set AP_CODESPACE)\n")
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	opts := sdk.SessionListOptions{
		CodespaceID: codespaceID,
		Status:      status,
		Limit:       limit,
	}

	ctx := context.Background()
	sessions, err := client.Sessions.List(ctx, opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(sessions)
		return 0
	}

	if len(sessions) == 0 {
		fmt.Println("No sessions found.")
		return 0
	}

	headers := []string{"ID", "Status", "Task", "Agent", "Created"}
	rows := make([][]string, len(sessions))
	for i, s := range sessions {
		taskID := "-"
		if s.TaskID != nil {
			taskID = *s.TaskID
		}
		agentID := "-"
		if s.AgentID != nil {
			agentID = *s.AgentID
		}
		rows[i] = []string{s.ID, s.Status, taskID, agentID, s.CreatedAt}
	}

	output.PrintTable(headers, rows)
	return 0
}

// Help returns detailed help text for the session list command.
func (c *SessionListCommand) Help() string {
	return `Usage: agentpane session list [options]

  List sessions within a codespace.

Required Flags:

  -codespace=<id>   Codespace ID (env: AP_CODESPACE)

Optional Flags:

  -status=<s>       Filter by status
  -limit=<n>        Maximum results (default: 50)

Global Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON
`
}

// Synopsis returns a one-line description of the session list command.
func (c *SessionListCommand) Synopsis() string {
	return "List sessions in a codespace"
}
