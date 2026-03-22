package command

import (
	"context"
	"fmt"
	"os"
)

// ProjectDeleteCommand deletes a project.
type ProjectDeleteCommand struct {
	*Meta
}

func (c *ProjectDeleteCommand) Run(args []string) int {
	flags := c.FlagSet("project delete")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	posArgs := flags.Args()
	if len(posArgs) != 1 {
		fmt.Fprintf(os.Stderr, "Error: project ID is required\nUsage: agentpane project delete <project-id>\n")
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if err := client.Projects.Delete(context.Background(), posArgs[0]); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	fmt.Fprintf(os.Stdout, "Deleted project %s\n", posArgs[0])
	return 0
}

func (c *ProjectDeleteCommand) Help() string {
	return "Usage: agentpane project delete <project-id> [options]\n\n  Delete a project.\n"
}

func (c *ProjectDeleteCommand) Synopsis() string { return "Delete a project" }
