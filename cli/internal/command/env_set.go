package command

import (
	"context"
	"fmt"
	"os"
)

// EnvSetCommand sets a sandbox environment variable.
type EnvSetCommand struct {
	*Meta
}

// Run executes the env set command.
func (c *EnvSetCommand) Run(args []string) int {
	flags := c.FlagSet("env set")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	remaining := flags.Args()
	if len(remaining) < 2 {
		fmt.Fprintf(os.Stderr, "Error: KEY and VALUE arguments are required\n")
		return 1
	}

	key := remaining[0]
	value := remaining[1]

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

	// Set the key.
	envMap[key] = value

	// Write back.
	if err := client.Settings.Set(ctx, settingsKey, envMap); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	fmt.Printf("Set %s = %s\n", key, maskValue(value))
	return 0
}

// Help returns detailed help text for the env set command.
func (c *EnvSetCommand) Help() string {
	return `Usage: agentpane env set <KEY> <VALUE> [options]

  Set a sandbox environment variable. If the key already exists, its value
  is overwritten.

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
`
}

// Synopsis returns a one-line description of the env set command.
func (c *EnvSetCommand) Synopsis() string {
	return "Set a sandbox environment variable"
}
