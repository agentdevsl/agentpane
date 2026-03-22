package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// ProjectCreateCommand creates a project folder.
type ProjectCreateCommand struct {
	*Meta
}

func (c *ProjectCreateCommand) Run(args []string) int {
	var name, description string
	flags := c.FlagSet("project create")
	flags.StringVar(&name, "name", "", "Project name (required)")
	flags.StringVar(&description, "description", "", "Project description")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	if name == "" {
		fmt.Fprintf(os.Stderr, "Error: -name is required\n")
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	opts := sdk.ProjectCreateOptions{Name: name}
	if description != "" {
		opts.Description = &description
	}

	folder, err := client.Projects.Create(context.Background(), opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(folder)
		return 0
	}

	fmt.Fprintf(os.Stdout, "Created project %s (%s)\n", folder.Name, folder.ID)
	return 0
}

func (c *ProjectCreateCommand) Help() string {
	return "Usage: agentpane project create [options]\n\n  Create a new project.\n\nOptions:\n  -name         Project name (required)\n  -description  Project description\n"
}

func (c *ProjectCreateCommand) Synopsis() string { return "Create a project" }
