// Package main implements the AgentPane CLI entry point and command registration.
package main

import (
	"os"

	"github.com/agentdevsl/agentpane/cli/internal/command"
	"github.com/agentdevsl/agentpane/cli/version"
	"github.com/mitchellh/cli"
)

// newCliRunner creates a cli.CLI instance with all commands registered.
func newCliRunner(meta *command.Meta) *cli.CLI {
	c := &cli.CLI{
		Name:    "agentpane",
		Version: version.Version,
		Args:    os.Args[1:],
		Commands: map[string]cli.CommandFactory{
			// Health
			"health": func() (cli.Command, error) {
				return &command.HealthCommand{Meta: meta}, nil
			},

			// Project commands (project folders)
			"project list": func() (cli.Command, error) {
				return &command.ProjectListCommand{Meta: meta}, nil
			},
			"project show": func() (cli.Command, error) {
				return &command.ProjectShowCommand{Meta: meta}, nil
			},
			"project create": func() (cli.Command, error) {
				return &command.ProjectCreateCommand{Meta: meta}, nil
			},
			"project delete": func() (cli.Command, error) {
				return &command.ProjectDeleteCommand{Meta: meta}, nil
			},

			// Codespace commands
			"codespace list": func() (cli.Command, error) {
				return &command.CodespaceListCommand{Meta: meta}, nil
			},
			"codespace show": func() (cli.Command, error) {
				return &command.CodespaceShowCommand{Meta: meta}, nil
			},
			"codespace create": func() (cli.Command, error) {
				return &command.CodespaceCreateCommand{Meta: meta}, nil
			},
			"codespace update": func() (cli.Command, error) {
				return &command.CodespaceUpdateCommand{Meta: meta}, nil
			},
			"codespace delete": func() (cli.Command, error) {
				return &command.CodespaceDeleteCommand{Meta: meta}, nil
			},

			// Task commands
			"task list": func() (cli.Command, error) {
				return &command.TaskListCommand{Meta: meta}, nil
			},
			"task create": func() (cli.Command, error) {
				return &command.TaskCreateCommand{Meta: meta}, nil
			},
			"task show": func() (cli.Command, error) {
				return &command.TaskShowCommand{Meta: meta}, nil
			},
			"task move": func() (cli.Command, error) {
				return &command.TaskMoveCommand{Meta: meta}, nil
			},
			"task run": func() (cli.Command, error) {
				return &command.TaskRunCommand{Meta: meta}, nil
			},
			"task approve": func() (cli.Command, error) {
				return &command.TaskApproveCommand{Meta: meta}, nil
			},
			"task reject": func() (cli.Command, error) {
				return &command.TaskRejectCommand{Meta: meta}, nil
			},

			// Session commands
			"session list": func() (cli.Command, error) {
				return &command.SessionListCommand{Meta: meta}, nil
			},
			"session show": func() (cli.Command, error) {
				return &command.SessionShowCommand{Meta: meta}, nil
			},
			"session events": func() (cli.Command, error) {
				return &command.SessionEventsCommand{Meta: meta}, nil
			},
		},
	}
	return c
}
