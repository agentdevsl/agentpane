package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
)

// ProjectShowCommand shows a project.
type ProjectShowCommand struct {
	*Meta
}

func (c *ProjectShowCommand) Run(args []string) int {
	flags := c.FlagSet("project show")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	posArgs := flags.Args()
	if len(posArgs) != 1 {
		fmt.Fprintf(os.Stderr, "Error: project ID is required\nUsage: agentpane project show <project-id>\n")
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	project, err := client.Folders.Get(context.Background(), posArgs[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(project)
		return 0
	}

	pairs := []output.KeyValue{
		{Key: "ID", Value: project.ID},
		{Key: "Name", Value: project.Name},
		{Key: "Slug", Value: project.Slug},
		{Key: "Icon", Value: project.Icon},
		{Key: "Color", Value: project.Color},
		{Key: "CreatedAt", Value: project.CreatedAt},
		{Key: "UpdatedAt", Value: project.UpdatedAt},
	}
	if project.Description != nil {
		pairs = append(pairs, output.KeyValue{Key: "Description", Value: *project.Description})
	}
	output.PrintKeyValue(pairs)
	return 0
}

func (c *ProjectShowCommand) Help() string {
	return "Usage: agentpane project show <project-id> [options]\n\n  Show project details.\n"
}

func (c *ProjectShowCommand) Synopsis() string { return "Show project details" }
