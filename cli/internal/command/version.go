package command

import (
	"fmt"
	"runtime"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/version"
)

// VersionCommand prints the CLI version and build information.
type VersionCommand struct {
	*Meta
}

// Run executes the version command.
func (c *VersionCommand) Run(args []string) int {
	flags := c.FlagSet("version")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(map[string]string{
			"version": version.Version,
			"go":      runtime.Version(),
			"os":      runtime.GOOS,
			"arch":    runtime.GOARCH,
		})
		return 0
	}

	fmt.Printf("agentpane %s (%s/%s, %s)\n", version.Version, runtime.GOOS, runtime.GOARCH, runtime.Version())
	return 0
}

// Help returns detailed help text for the version command.
func (c *VersionCommand) Help() string {
	return `Usage: agentpane version [options]

  Print the CLI version and build information.

Options:

  -json             Output as JSON

Examples:

  # Print version
  agentpane version

  # Get version as JSON for scripting
  agentpane version -json
`
}

// Synopsis returns a one-line description of the version command.
func (c *VersionCommand) Synopsis() string {
	return "Print CLI version"
}
