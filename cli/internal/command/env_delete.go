package command

import (
	"context"
	"fmt"
	"os"
)

// EnvDeleteCommand deletes a sandbox environment variable.
type EnvDeleteCommand struct {
	*Meta
}

// Run executes the env delete command.
func (c *EnvDeleteCommand) Run(args []string) int {
	flags := c.FlagSet("env delete")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	remaining := flags.Args()
	if len(remaining) < 1 {
		fmt.Fprintf(os.Stderr, "Error: KEY argument is required\n")
		return 1
	}

	key := remaining[0]

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	ctx := context.Background()

	// Read current env map.
	envMap, err := getEnvMap(ctx, client)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if _, exists := envMap[key]; !exists {
		fmt.Fprintf(os.Stderr, "Error: key %q not found\n", key)
		return 1
	}

	// Delete the key.
	delete(envMap, key)

	// Write back.
	if err := client.Settings.Set(ctx, settingsKey, envMap); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	fmt.Printf("Deleted %s\n", key)
	return 0
}

// Help returns detailed help text for the env delete command.
func (c *EnvDeleteCommand) Help() string {
	return `Usage: agentpane env delete <KEY> [options]

  Delete a sandbox environment variable.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
`
}

// Synopsis returns a one-line description of the env delete command.
func (c *EnvDeleteCommand) Synopsis() string {
	return "Delete a sandbox environment variable"
}
