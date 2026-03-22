package command

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/agentdevsl/agentpane/cli/internal/output"
)

// SessionEventsCommand lists events for a session.
type SessionEventsCommand struct {
	*Meta
}

// Run executes the session events command.
func (c *SessionEventsCommand) Run(args []string) int {
	var limit int

	flags := c.FlagSet("session events")
	flags.IntVar(&limit, "limit", 100, "Maximum number of events to return")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	remaining := flags.Args()
	if len(remaining) != 1 {
		fmt.Fprintf(os.Stderr, "Error: exactly one session ID is required\n")
		return 1
	}
	sessionID := remaining[0]

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	ctx := context.Background()
	events, err := client.Sessions.GetEvents(ctx, sessionID, limit, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(events)
		return 0
	}

	if len(events) == 0 {
		fmt.Println("No events found.")
		return 0
	}

	headers := []string{"Type", "Timestamp", "Data"}
	rows := make([][]string, len(events))
	for i, e := range events {
		ts := time.UnixMilli(e.Timestamp).Format(time.RFC3339)
		data := truncateData(e.Data, 80)
		rows[i] = []string{e.Type, ts, data}
	}

	output.PrintTable(headers, rows)
	return 0
}

// truncateData converts event data to a string and truncates to maxLen.
func truncateData(data interface{}, maxLen int) string {
	if data == nil {
		return "-"
	}

	var s string
	switch v := data.(type) {
	case string:
		s = v
	default:
		b, err := json.Marshal(v)
		if err != nil {
			s = fmt.Sprintf("%v", v)
		} else {
			s = string(b)
		}
	}

	if len(s) > maxLen {
		return s[:maxLen-3] + "..."
	}
	return s
}

// Help returns detailed help text for the session events command.
func (c *SessionEventsCommand) Help() string {
	return `Usage: agentpane session events <session-id> [options]

  List events for a session. Events are displayed in chronological order
  with truncated data for readability.

Options:

  -limit=<n>        Maximum events to return (default: 100)

Global Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON
`
}

// Synopsis returns a one-line description of the session events command.
func (c *SessionEventsCommand) Synopsis() string {
	return "List events for a session"
}
