package command

import (
	"context"
	"fmt"
	"os"
)

// EnvClearCommand removes all sandbox environment variables.
type EnvClearCommand struct {
	*Meta
}

// Run executes the env clear command.
func (c *EnvClearCommand) Run(args []string) int {
	flags := c.FlagSet("env clear")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	ctx := context.Background()

	// Write an empty map to clear all env vars.
	emptyMap := map[string]string{}
	if err := client.Settings.Set(ctx, settingsKey, emptyMap); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	fmt.Println("All sandbox environment variables cleared.")
	return 0
}

// Help returns detailed help text for the env clear command.
func (c *EnvClearCommand) Help() string {
	return `Usage: agentpane env clear [options]

  Remove all sandbox environment variables.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
`
}

// Synopsis returns a one-line description of the env clear command.
func (c *EnvClearCommand) Synopsis() string {
	return "Clear all sandbox environment variables"
}
