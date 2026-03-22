package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
)

// ProjectListCommand lists project folders.
type ProjectListCommand struct {
	*Meta
}

func (c *ProjectListCommand) Run(args []string) int {
	flags := c.FlagSet("project list")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	folders, err := client.Folders.List(context.Background())
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error listing projects: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(folders)
		return 0
	}

	headers := []string{"ID", "Name", "Slug", "Icon", "Color"}
	rows := make([][]string, len(folders))
	for i, f := range folders {
		rows[i] = []string{f.ID, f.Name, f.Slug, f.Icon, f.Color}
	}
	output.PrintTable(headers, rows)
	return 0
}

func (c *ProjectListCommand) Help() string {
	return "Usage: agentpane project list [options]\n\n  List all projects.\n"
}

func (c *ProjectListCommand) Synopsis() string { return "List projects" }
