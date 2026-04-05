package command

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
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
	if len(remaining) < 1 {
		fmt.Fprintf(os.Stderr, "Error: KEY argument is required\n")
		return 1
	}

	key := remaining[0]
	var value string

	if len(remaining) >= 2 {
		// Value from command line argument
		value = remaining[1]
	} else {
		// No value argument — read from stdin (avoids shell history exposure)
		// Supports: echo "secret" | agentpane env set KEY
		//           agentpane env set KEY < secret.txt
		stat, _ := os.Stdin.Stat()
		if (stat.Mode() & os.ModeCharDevice) == 0 {
			// Stdin is a pipe — read one line
			scanner := bufio.NewScanner(os.Stdin)
			if scanner.Scan() {
				value = strings.TrimSpace(scanner.Text())
			}
		}
		if value == "" {
			fmt.Fprintf(os.Stderr, "Error: VALUE required as argument or piped via stdin\n")
			fmt.Fprintf(os.Stderr, "  agentpane env set KEY VALUE\n")
			fmt.Fprintf(os.Stderr, "  echo \"secret\" | agentpane env set KEY\n")
			return 1
		}
	}

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
	return `Usage: agentpane env set <KEY> [VALUE] [options]

  Set a sandbox environment variable. If the key already exists, its value
  is overwritten.

  For secrets, pipe the value via stdin to avoid shell history exposure:

    echo "$TFE_TOKEN" | agentpane env set TFE_TOKEN
    cat secret.txt | agentpane env set API_KEY

Options:

  -address=<url>    API base URL (env: AP_ADDRESS)
  -token=<token>    API token (env: AP_TOKEN)
`
}

// Synopsis returns a one-line description of the env set command.
func (c *EnvSetCommand) Synopsis() string {
	return "Set a sandbox environment variable"
}
