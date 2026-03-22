package command

import (
	"context"
	"fmt"
	"os"
	"strconv"

	"github.com/agentdevsl/agentpane/cli/internal/output"
)

// CodespaceShowCommand displays details for a single codespace.
type CodespaceShowCommand struct {
	*Meta
}

// Run executes the codespace show command.
func (c *CodespaceShowCommand) Run(args []string) int {
	flags := c.FlagSet("codespace show")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	remaining := flags.Args()
	if len(remaining) != 1 {
		fmt.Fprintf(os.Stderr, "Error: exactly one codespace ID is required\n")
		return 1
	}
	codespaceID := remaining[0]

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	ctx := context.Background()
	cs, err := client.Codespaces.Get(ctx, codespaceID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(cs)
		return 0
	}

	pairs := []output.KeyValue{
		{Key: "ID", Value: cs.ID},
		{Key: "Name", Value: cs.Name},
		{Key: "Path", Value: cs.Path},
		{Key: "Project ID", Value: cs.ProjectID},
		{Key: "Max Agents", Value: strconv.Itoa(cs.MaxConcurrentAgents)},
		{Key: "Created", Value: cs.CreatedAt},
		{Key: "Updated", Value: cs.UpdatedAt},
	}

	if cs.Description != nil {
		pairs = append(pairs, output.KeyValue{Key: "Description", Value: *cs.Description})
	}
	if cs.GithubOwner != nil {
		pairs = append(pairs, output.KeyValue{Key: "GitHub Owner", Value: *cs.GithubOwner})
	}
	if cs.GithubRepo != nil {
		pairs = append(pairs, output.KeyValue{Key: "GitHub Repo", Value: *cs.GithubRepo})
	}

	output.PrintKeyValue(pairs)
	return 0
}

// Help returns detailed help text for the codespace show command.
func (c *CodespaceShowCommand) Help() string {
	return `Usage: agentpane codespace show <codespace-id> [options]

  Show details for a single codespace.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON
`
}

// Synopsis returns a one-line description of the codespace show command.
func (c *CodespaceShowCommand) Synopsis() string {
	return "Show codespace details"
}
