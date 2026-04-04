package command

import (
	"context"
	"fmt"
	"os"
	"sort"

	"github.com/agentdevsl/agentpane/cli/internal/output"
)

// EnvListCommand lists all sandbox environment variables.
type EnvListCommand struct {
	*Meta
}

// Run executes the env list command.
func (c *EnvListCommand) Run(args []string) int {
	flags := c.FlagSet("env list")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	ctx := context.Background()
	envMap, err := getEnvMap(ctx, client)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(envMap)
		return 0
	}

	if len(envMap) == 0 {
		fmt.Println("No sandbox environment variables set.")
		return 0
	}

	// Sort keys for deterministic output.
	keys := make([]string, 0, len(envMap))
	for k := range envMap {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	headers := []string{"Key", "Value"}
	rows := make([][]string, len(keys))
	for i, k := range keys {
		rows[i] = []string{k, maskValue(envMap[k])}
	}

	output.PrintTable(headers, rows)
	return 0
}

// Help returns detailed help text for the env list command.
func (c *EnvListCommand) Help() string {
	return `Usage: agentpane env list [options]

  List all sandbox environment variables. Values are masked in output.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
  -json             Output as JSON (values unmasked)
`
}

// Synopsis returns a one-line description of the env list command.
func (c *EnvListCommand) Synopsis() string {
	return "List sandbox environment variables"
}
