package main

import (
	"fmt"
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/command"
)

func main() {
	meta := command.NewMeta()
	c := newCliRunner(meta)

	exitStatus, err := c.Run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
	}

	// mitchellh/cli returns 127 when help text is displayed (no command given).
	// Map this to exit 0 so that `agentpane` or `agentpane --help` don't
	// report a confusing non-zero exit code.
	if exitStatus == 127 {
		exitStatus = 0
	}

	os.Exit(exitStatus)
}
