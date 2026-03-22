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

	os.Exit(exitStatus)
}
