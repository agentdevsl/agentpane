package command

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/agentdevsl/agentpane/cli/internal/output"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// TaskCreateCommand creates a new task in a codespace.
type TaskCreateCommand struct {
	*Meta
}

// Run executes the task create command.
func (c *TaskCreateCommand) Run(args []string) int {
	var title, description, priority, labels, skillID, skillName, executionSkillID, executionSkillName, approvalMode string
	var autoStart bool

	flags := c.FlagSet("task create")
	flags.StringVar(&title, "title", "", "Task title (required)")
	flags.StringVar(&description, "description", "", "Task description")
	flags.StringVar(&priority, "priority", "medium", "Priority: high, medium, low")
	flags.StringVar(&labels, "labels", "", "Comma-separated labels")
	flags.StringVar(&skillID, "skill", "", "Skill ID (directory name under .claude/skills/)")
	flags.StringVar(&skillName, "skill-name", "", "Skill display name")
	flags.StringVar(&executionSkillID, "execution-skill", "", "Execution skill ID for skill chaining")
	flags.StringVar(&executionSkillName, "execution-skill-name", "", "Execution skill display name")
	flags.BoolVar(&autoStart, "auto-start", false, "Automatically start the task (move to in_progress)")
	flags.StringVar(&approvalMode, "approval-mode", "", "Approval mode: human or agent")
	if err := flags.Parse(args); err != nil {
		return 1
	}

	codespaceID := c.CodespaceID()
	if codespaceID == "" {
		fmt.Fprintf(os.Stderr, "Error: -codespace is required (or set AP_CODESPACE)\n")
		return 1
	}
	if title == "" {
		fmt.Fprintf(os.Stderr, "Error: -title is required\n")
		return 1
	}

	client, err := c.Client()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	opts := sdk.TaskCreateOptions{
		CodespaceID: codespaceID,
		Title:       title,
		Priority:    priority,
	}
	if description != "" {
		opts.Description = &description
	}
	if labels != "" {
		opts.Labels = strings.Split(labels, ",")
		for i := range opts.Labels {
			opts.Labels[i] = strings.TrimSpace(opts.Labels[i])
		}
	}
	if skillID != "" {
		opts.SkillID = &skillID
		// Default skillName to skillId if not explicitly provided
		if skillName == "" {
			opts.SkillName = &skillID
		} else {
			opts.SkillName = &skillName
		}
	} else if skillName != "" {
		opts.SkillName = &skillName
	}
	if executionSkillID != "" {
		opts.ExecutionSkillID = &executionSkillID
		// Default executionSkillName to executionSkillID if not explicitly provided
		if executionSkillName == "" {
			opts.ExecutionSkillName = &executionSkillID
		} else {
			opts.ExecutionSkillName = &executionSkillName
		}
	} else if executionSkillName != "" {
		opts.ExecutionSkillName = &executionSkillName
	}
	if autoStart {
		opts.AutoStart = &autoStart
	}
	if approvalMode != "" {
		opts.ApprovalMode = &approvalMode
	}

	ctx := context.Background()
	task, err := client.Tasks.Create(ctx, opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}

	if c.JSONOutput() {
		output.PrintJSON(task)
		return 0
	}

	fmt.Printf("Task created: %s\n", task.ID)
	kvs := []output.KeyValue{
		{Key: "ID", Value: task.ID},
		{Key: "Title", Value: task.Title},
		{Key: "Column", Value: task.Column},
		{Key: "Priority", Value: task.Priority},
	}
	if task.SkillID != nil {
		kvs = append(kvs, output.KeyValue{Key: "Skill", Value: *task.SkillID})
	}
	if task.ExecutionSkillID != nil {
		kvs = append(kvs, output.KeyValue{Key: "Execution Skill", Value: *task.ExecutionSkillID})
	}
	if task.ApprovalMode != nil {
		kvs = append(kvs, output.KeyValue{Key: "Approval", Value: *task.ApprovalMode})
	}
	output.PrintKeyValue(kvs)
	return 0
}

// Help returns detailed help text for the task create command.
func (c *TaskCreateCommand) Help() string {
	return `Usage: agentpane task create [options]

  Create a new task in a codespace.

Required Flags:

  -codespace=<id>     Codespace ID (env: AP_CODESPACE)
  -title=<title>      Task title

Optional Flags:

  -description=<d>    Task description
  -priority=<p>       Priority: high, medium, low (default: medium)
  -labels=<l1,l2>     Comma-separated labels
  -skill=<id>         Skill ID (directory name under .claude/skills/)
  -skill-name=<name>  Skill display name
  -execution-skill=<id>       Execution skill ID for skill chaining
  -execution-skill-name=<name> Execution skill display name
  -auto-start                 Automatically start the task (move to in_progress)
  -approval-mode=<mode>       Approval mode: human (default) or agent

Global Options:

  -address=<url>      API base URL (env: AP_ADDRESS)
  -token=<token>      API token (env: AP_TOKEN)
  -json               Output as JSON
`
}

// Synopsis returns a one-line description of the task create command.
func (c *TaskCreateCommand) Synopsis() string {
	return "Create a new task"
}
