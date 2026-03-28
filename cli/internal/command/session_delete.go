package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
)

// SessionDeleteCommand deletes a session by ID.
type SessionDeleteCommand struct {
	*Meta
}

// Run executes the session delete command.
func (c *SessionDeleteCommand) Run(args []string) int {
	flags := c.FlagSet("session delete")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	posArgs := flags.Args()
	if len(posArgs) != 1 {
		fmt.Fprintf(os.Stderr, "Error: session ID is required\nUsage: agentpane session delete <session-id>\n")
		return 1
	}
	sessionID := posArgs[0]

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if err := client.Sessions.Delete(context.Background(), sessionID); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(map[string]interface{}{
			"id":      sessionID,
			"deleted": true,
		})
	} else {
		fmt.Fprintf(os.Stdout, "Deleted session %s\n", sessionID)
	}
	return 0
}

// Help returns detailed help text for the session delete command.
func (c *SessionDeleteCommand) Help() string {
	return `Usage: agentpane session delete <session-id> [options]

  Delete a session by ID.

Global Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON

Examples:

  # Delete a session
  agentpane session delete sess_abc123

  # Delete with JSON output for scripting
  agentpane session delete sess_abc123 -json
`
}

// Synopsis returns a one-line description of the session delete command.
func (c *SessionDeleteCommand) Synopsis() string {
	return "Delete a session"
}
