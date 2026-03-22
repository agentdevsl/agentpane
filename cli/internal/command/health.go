package command

import (
	"context"
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/output"
)

// HealthCommand checks the AgentPane API health status.
type HealthCommand struct {
	*Meta
}

// Run executes the health check command.
func (c *HealthCommand) Run(args []string) int {
	flags := c.FlagSet("health")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	ctx := context.Background()
	status, err := client.Health.Check(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(status)
		return 0
	}

	output.PrintKeyValue([]output.KeyValue{
		{Key: "Status", Value: status.Status},
		{Key: "Database", Value: status.Database},
	})
	return 0
}

// Help returns detailed help text for the health command.
func (c *HealthCommand) Help() string {
	return `Usage: agentpane health [options]

  Check the AgentPane API health status.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON
`
}

// Synopsis returns a one-line description of the health command.
func (c *HealthCommand) Synopsis() string {
	return "Check API health status"
}
