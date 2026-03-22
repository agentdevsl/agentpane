package command

import (
	"context"
	"fmt"
	"os"
	"strconv"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// SessionShowCommand displays details for a single session, including its summary.
type SessionShowCommand struct {
	*Meta
}

// Run executes the session show command.
func (c *SessionShowCommand) Run(args []string) int {
	flags := c.FlagSet("session show")
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
	session, err := client.Sessions.Get(ctx, sessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	// Fetch summary (may not exist for all sessions).
	summary, summaryErr := client.Sessions.GetSummary(ctx, sessionID)
	if summaryErr != nil && !sdk.IsNotFound(summaryErr) {
		fmt.Fprintf(os.Stderr, "Warning: failed to fetch session summary: %s\n", summaryErr)
	}

	if c.JSONOutput() {
		result := map[string]interface{}{
			"session": session,
		}
		if summary != nil {
			result["summary"] = summary
		}
		output.PrintJSON(result)
		return 0
	}

	pairs := []output.KeyValue{
		{Key: "ID", Value: session.ID},
		{Key: "Codespace", Value: session.CodespaceID},
		{Key: "Status", Value: session.Status},
		{Key: "Created", Value: session.CreatedAt},
		{Key: "Updated", Value: session.UpdatedAt},
	}

	if session.TaskID != nil {
		pairs = append(pairs, output.KeyValue{Key: "Task ID", Value: *session.TaskID})
	}
	if session.AgentID != nil {
		pairs = append(pairs, output.KeyValue{Key: "Agent ID", Value: *session.AgentID})
	}
	if session.Title != nil {
		pairs = append(pairs, output.KeyValue{Key: "Title", Value: *session.Title})
	}
	if session.SandboxProvider != nil {
		pairs = append(pairs, output.KeyValue{Key: "Sandbox", Value: *session.SandboxProvider})
	}
	if session.ClosedAt != nil {
		pairs = append(pairs, output.KeyValue{Key: "Closed At", Value: *session.ClosedAt})
	}

	output.PrintKeyValue(pairs)

	// Print summary if available.
	if summary != nil {
		fmt.Println()
		fmt.Println("Session Summary:")

		summaryPairs := []output.KeyValue{
			{Key: "Turns", Value: strconv.Itoa(summary.TurnsCount)},
			{Key: "Tokens Used", Value: strconv.Itoa(summary.TokensUsed)},
			{Key: "Files Modified", Value: strconv.Itoa(summary.FilesModified)},
			{Key: "Lines Added", Value: strconv.Itoa(summary.LinesAdded)},
			{Key: "Lines Removed", Value: strconv.Itoa(summary.LinesRemoved)},
		}
		if summary.DurationMs != nil {
			durationSec := float64(*summary.DurationMs) / 1000.0
			summaryPairs = append(summaryPairs, output.KeyValue{
				Key:   "Duration",
				Value: fmt.Sprintf("%.1fs", durationSec),
			})
		}
		if summary.FinalStatus != nil {
			summaryPairs = append(summaryPairs, output.KeyValue{Key: "Final Status", Value: *summary.FinalStatus})
		}

		output.PrintKeyValue(summaryPairs)
	}

	return 0
}

// Help returns detailed help text for the session show command.
func (c *SessionShowCommand) Help() string {
	return `Usage: agentpane session show <session-id> [options]

  Show details for a single session, including its summary metrics.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON
`
}

// Synopsis returns a one-line description of the session show command.
func (c *SessionShowCommand) Synopsis() string {
	return "Show session details and summary"
}
