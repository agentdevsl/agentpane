package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// CodespaceUpdateCommand updates a codespace.
type CodespaceUpdateCommand struct {
	*Meta
}

func (c *CodespaceUpdateCommand) Run(args []string) int {
	var name, description string
	flags := c.FlagSet("codespace update")
	flags.StringVar(&name, "name", "", "New name")
	flags.StringVar(&description, "description", "", "New description")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	posArgs := flags.Args()
	if len(posArgs) != 1 {
		fmt.Fprintf(os.Stderr, "Error: codespace ID is required\nUsage: agentpane codespace update <id> [options]\n")
		return 1
	}

	if name == "" && description == "" {
		fmt.Fprintf(os.Stderr, "Error: at least one of -name or -description is required\n")
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	opts := sdk.CodespaceUpdateOptions{}
	if name != "" {
		opts.Name = &name
	}
	if description != "" {
		opts.Description = &description
	}

	cs, err := client.Codespaces.Update(context.Background(), posArgs[0], opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error updating codespace: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(cs)
		return 0
	}

	fmt.Fprintf(os.Stdout, "Updated codespace %s (%s)\n", cs.Name, cs.ID)
	return 0
}

func (c *CodespaceUpdateCommand) Help() string {
	return "Usage: agentpane codespace update <id> [options]\n\n  Update a codespace.\n\nOptions:\n  -name         New name\n  -description  New description\n"
}

func (c *CodespaceUpdateCommand) Synopsis() string { return "Update a codespace" }
