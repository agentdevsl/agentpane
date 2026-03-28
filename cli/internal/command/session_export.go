package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
)

// SessionExportCommand exports a session in the specified format.
type SessionExportCommand struct {
	*Meta
}

// Run executes the session export command.
func (c *SessionExportCommand) Run(args []string) int {
	var exportFormat string

	flags := c.FlagSet("session export")
	flags.StringVar(&exportFormat, "format", "json", "Export format: json, markdown, csv")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	posArgs := flags.Args()
	if len(posArgs) != 1 {
		fmt.Fprintf(os.Stderr, "Error: session ID is required\nUsage: agentpane session export <session-id> [flags]\n")
		return 1
	}
	sessionID := posArgs[0]

	// Validate export format.
	switch exportFormat {
	case "json", "markdown", "csv":
		// valid
	default:
		fmt.Fprintf(os.Stderr, "Error: invalid format %q (must be json, markdown, or csv)\n", exportFormat)
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	result, err := client.Sessions.Export(context.Background(), sessionID, exportFormat)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(map[string]interface{}{
			"session_id": sessionID,
			"format":     result.Format,
			"content":    result.Content,
		})
	} else {
		// Print the exported content directly.
		fmt.Print(result.Content)
	}

	return 0
}

// Help returns detailed help text for the session export command.
func (c *SessionExportCommand) Help() string {
	return `Usage: agentpane session export <session-id> [options]

  Export a session in the specified format. The exported content is
  printed directly to stdout for easy redirection to a file.

Options:

  -format=<fmt>     Export format: json, markdown, csv (default: json)

Global Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Wrap output in JSON envelope

Examples:

  # Export session as JSON
  agentpane session export sess_abc123

  # Export as markdown and save to file
  agentpane session export sess_abc123 -format markdown > session.md

  # Export as CSV
  agentpane session export sess_abc123 -format csv

  # Export with JSON envelope for scripting
  agentpane session export sess_abc123 -json
`
}

// Synopsis returns a one-line description of the session export command.
func (c *SessionExportCommand) Synopsis() string {
	return "Export a session"
}
