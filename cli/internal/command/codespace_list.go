package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
)

// CodespaceListCommand lists all codespaces.
type CodespaceListCommand struct {
	*Meta
}

// Run executes the codespace list command.
func (c *CodespaceListCommand) Run(args []string) int {
	flags := c.FlagSet("codespace list")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	ctx := context.Background()
	codespaces, err := client.Codespaces.List(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(codespaces)
		return 0
	}

	if len(codespaces) == 0 {
		fmt.Println("No codespaces found.")
		return 0
	}

	headers := []string{"ID", "Name", "Path", "Updated"}
	rows := make([][]string, len(codespaces))
	for i, cs := range codespaces {
		rows[i] = []string{cs.ID, cs.Name, cs.Path, cs.UpdatedAt}
	}

	output.PrintTable(headers, rows)
	return 0
}

// Help returns detailed help text for the codespace list command.
func (c *CodespaceListCommand) Help() string {
	return `Usage: agentpane codespace list [options]

  List all codespaces.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON
`
}

// Synopsis returns a one-line description of the codespace list command.
func (c *CodespaceListCommand) Synopsis() string {
	return "List all codespaces"
}
