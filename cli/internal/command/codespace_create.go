package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// CodespaceCreateCommand creates a new codespace.
type CodespaceCreateCommand struct {
	*Meta
}

// Run executes the codespace create command.
func (c *CodespaceCreateCommand) Run(args []string) int {
	var name, path, folderID, description string

	flags := c.FlagSet("codespace create")
	flags.StringVar(&name, "name", "", "Codespace name (required)")
	flags.StringVar(&path, "path", "", "Filesystem path (required)")
	flags.StringVar(&folderID, "project-id", "", "Project ID (required)")
	flags.StringVar(&description, "description", "", "Description")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	if name == "" {
		fmt.Fprintf(os.Stderr, "Error: -name is required\n")
		return 1
	}
	if path == "" {
		fmt.Fprintf(os.Stderr, "Error: -path is required\n")
		return 1
	}
	if folderID == "" {
		fmt.Fprintf(os.Stderr, "Error: -project-id is required\n")
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	opts := sdk.CodespaceCreateOptions{
		Name:     name,
		Path:     path,
		ProjectID: folderID,
	}
	if description != "" {
		opts.Description = &description
	}

	ctx := context.Background()
	cs, err := client.Codespaces.Create(ctx, opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(cs)
		return 0
	}

	fmt.Printf("Codespace created: %s\n", cs.ID)
	output.PrintKeyValue([]output.KeyValue{
		{Key: "ID", Value: cs.ID},
		{Key: "Name", Value: cs.Name},
		{Key: "Path", Value: cs.Path},
	})
	return 0
}

// Help returns detailed help text for the codespace create command.
func (c *CodespaceCreateCommand) Help() string {
	return `Usage: agentpane codespace create [options]

  Create a new codespace.

Required Flags:

  -name=<name>          Codespace name
  -path=<path>          Filesystem path
  -project-id=<id>       Project ID

Optional Flags:

  -description=<desc>   Description

Global Options:

  -address=<url>        API base URL (env: AP_ADDRESS)
  -token=<token>        API token (env: AP_TOKEN)
  -json                 Output as JSON
`
}

// Synopsis returns a one-line description of the codespace create command.
func (c *CodespaceCreateCommand) Synopsis() string {
	return "Create a new codespace"
}
