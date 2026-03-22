package command

import (
	"context"
	"fmt"
	"os"
)

// CodespaceDeleteCommand deletes a codespace.
type CodespaceDeleteCommand struct {
	*Meta
}

func (c *CodespaceDeleteCommand) Run(args []string) int {
	flags := c.FlagSet("codespace delete")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	posArgs := flags.Args()
	if len(posArgs) != 1 {
		fmt.Fprintf(os.Stderr, "Error: codespace ID is required\nUsage: agentpane codespace delete <id>\n")
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if err := client.Codespaces.Delete(context.Background(), posArgs[0]); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	fmt.Fprintf(os.Stdout, "Deleted codespace %s\n", posArgs[0])
	return 0
}

func (c *CodespaceDeleteCommand) Help() string {
	return "Usage: agentpane codespace delete <id> [options]\n\n  Delete a codespace.\n"
}

func (c *CodespaceDeleteCommand) Synopsis() string { return "Delete a codespace" }
