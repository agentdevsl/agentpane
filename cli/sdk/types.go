// Package sdk provides a Go client for the AgentPane REST API.
package sdk

// Task column constants.
const (
	ColumnBacklog         = "backlog"
	ColumnQueued          = "queued"
	ColumnInProgress      = "in_progress"
	ColumnWaitingApproval = "waiting_approval"
	ColumnVerified        = "verified"
)

// Task priority constants.
const (
	PriorityHigh   = "high"
	PriorityMedium = "medium"
	PriorityLow    = "low"
)

// Agent status constants.
const (
	AgentStatusIdle      = "idle"
	AgentStatusStarting  = "starting"
	AgentStatusPlanning  = "planning"
	AgentStatusRunning   = "running"
	AgentStatusPaused    = "paused"
	AgentStatusError     = "error"
	AgentStatusCompleted = "completed"
)

// Session status constants.
const (
	SessionStatusIdle         = "idle"
	SessionStatusInitializing = "initializing"
	SessionStatusActive       = "active"
	SessionStatusPaused       = "paused"
	SessionStatusClosing      = "closing"
	SessionStatusClosed       = "closed"
	SessionStatusError        = "error"
)

// Export format constants.
const (
	ExportFormatJSON     = "json"
	ExportFormatMarkdown = "markdown"
	ExportFormatCSV      = "csv"
)

// ExportResponse contains the exported session data.
type ExportResponse struct {
	Format  string `json:"format"`
	Content string `json:"content"`
}

// Codespace represents a development workspace (formerly called Project).
type Codespace struct {
	ID                  string  `json:"id"`
	ProjectID     string  `json:"projectFolderId"`
	Name                string  `json:"name"`
	Path                string  `json:"path"`
	Description         *string `json:"description,omitempty"`
	MaxConcurrentAgents int     `json:"maxConcurrentAgents"`
	GithubOwner         *string `json:"githubOwner,omitempty"`
	GithubRepo          *string `json:"githubRepo,omitempty"`
	CreatedAt           string  `json:"createdAt"`
	UpdatedAt           string  `json:"updatedAt"`
}

// Task represents a unit of work within a codespace.
//
// Valid columns: backlog, queued, in_progress, waiting_approval, verified.
// Valid priorities: high, medium, low.
type Task struct {
	ID              string   `json:"id"`
	CodespaceID     string   `json:"codespaceId"`
	Title           string   `json:"title"`
	Description     *string  `json:"description,omitempty"`
	Column          string   `json:"column"`
	Position        int      `json:"position"`
	Priority        string   `json:"priority"`
	Labels          []string `json:"labels"`
	SkillID            *string  `json:"skillId,omitempty"`
	SkillName          *string  `json:"skillName,omitempty"`
	ExecutionSkillID   *string  `json:"executionSkillId,omitempty"`
	ExecutionSkillName *string  `json:"executionSkillName,omitempty"`
	AgentID            *string  `json:"agentId,omitempty"`
	SessionID       *string  `json:"sessionId,omitempty"`
	WorktreeID      *string  `json:"worktreeId,omitempty"`
	Branch          *string  `json:"branch,omitempty"`
	Plan            *string  `json:"plan,omitempty"`
	LastAgentStatus *string  `json:"lastAgentStatus,omitempty"`
	CreatedAt       string   `json:"createdAt"`
	UpdatedAt       string   `json:"updatedAt"`
}

// Agent represents an AI agent that executes tasks.
//
// Valid statuses: idle, starting, planning, running, paused, error, completed.
// Valid types: task, conversational, background.
type Agent struct {
	ID               string  `json:"id"`
	CodespaceID      string  `json:"codespaceId"`
	Name             string  `json:"name"`
	Type             string  `json:"type"`
	Status           string  `json:"status"`
	CurrentTaskID    *string `json:"currentTaskId,omitempty"`
	CurrentSessionID *string `json:"currentSessionId,omitempty"`
	CurrentTurn      int     `json:"currentTurn"`
	CreatedAt        string  `json:"createdAt"`
	UpdatedAt        string  `json:"updatedAt"`
}

// Session represents an agent execution session.
//
// Valid statuses: idle, initializing, active, paused, closing, closed, error.
type Session struct {
	ID                 string  `json:"id"`
	CodespaceID        string  `json:"codespaceId"`
	TaskID             *string `json:"taskId,omitempty"`
	AgentID            *string `json:"agentId,omitempty"`
	Status             string  `json:"status"`
	Title              *string `json:"title,omitempty"`
	SandboxProvider    *string `json:"sandboxProvider,omitempty"`
	SandboxContainerID *string `json:"sandboxContainerId,omitempty"`
	CreatedAt          string  `json:"createdAt"`
	UpdatedAt          string  `json:"updatedAt"`
	ClosedAt           *string `json:"closedAt,omitempty"`
}

// SessionEvent represents a single event emitted during a session.
type SessionEvent struct {
	ID        string      `json:"id"`
	Type      string      `json:"type"`
	Timestamp int64       `json:"timestamp"`
	Data      interface{} `json:"data"`
}

// SessionSummary contains aggregated metrics for a completed session.
type SessionSummary struct {
	SessionID     string  `json:"sessionId"`
	DurationMs    *int64  `json:"durationMs"`
	TurnsCount    int     `json:"turnsCount"`
	TokensUsed    int     `json:"tokensUsed"`
	FilesModified int     `json:"filesModified"`
	LinesAdded    int     `json:"linesAdded"`
	LinesRemoved  int     `json:"linesRemoved"`
	FinalStatus   *string `json:"finalStatus"`
}

// Project groups codespaces into organizational folders.
type Project struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Slug        string  `json:"slug"`
	Description *string `json:"description,omitempty"`
	Icon        string  `json:"icon"`
	Color       string  `json:"color"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

// Team represents an organizational team.
type Team struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Slug        string  `json:"slug"`
	Description *string `json:"description,omitempty"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

// HealthStatus contains the result of a health check.
type HealthStatus struct {
	Status   string `json:"status"`
	Database string `json:"database,omitempty"`
}

// GitStatus contains the working tree status for a codespace.
type GitStatus struct {
	Branch   string      `json:"branch,omitempty"`
	Clean    bool        `json:"clean,omitempty"`
	Files    interface{} `json:"files,omitempty"`
	Ahead    int         `json:"ahead,omitempty"`
	Behind   int         `json:"behind,omitempty"`
	Tracking string      `json:"tracking,omitempty"`
}

// GitBranch represents a git branch.
type GitBranch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
}

// GitCommit represents a git commit entry.
type GitCommit struct {
	Hash    string `json:"hash,omitempty"`
	Message string `json:"message,omitempty"`
	Author  string `json:"author,omitempty"`
	Date    string `json:"date,omitempty"`
}

// ListResponse is a generic wrapper for paginated list responses.
type ListResponse[T any] struct {
	Items      []T         `json:"items"`
	Pagination *Pagination `json:"pagination,omitempty"`
}

// Pagination holds pagination metadata returned by list endpoints.
type Pagination struct {
	Total  int `json:"total"`
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}

// CodespaceCreateOptions specifies the parameters for creating a codespace.
type CodespaceCreateOptions struct {
	Name        string  `json:"name"`
	Path        string  `json:"path"`
	ProjectID   string  `json:"projectFolderId"`
	Description *string `json:"description,omitempty"`
}

// CodespaceUpdateOptions specifies the parameters for updating a codespace.
type CodespaceUpdateOptions struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
}

// ProjectCreateOptions specifies the parameters for creating a project.
type ProjectCreateOptions struct {
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
}

// TaskCreateOptions specifies the parameters for creating a task.
type TaskCreateOptions struct {
	CodespaceID string   `json:"codespaceId"`
	Title       string   `json:"title"`
	Description *string  `json:"description,omitempty"`
	Priority    string   `json:"priority,omitempty"`
	Labels      []string `json:"labels,omitempty"`
	SkillID            *string  `json:"skillId,omitempty"`
	SkillName          *string  `json:"skillName,omitempty"`
	ExecutionSkillID   *string  `json:"executionSkillId,omitempty"`
	ExecutionSkillName *string  `json:"executionSkillName,omitempty"`
}

// TaskUpdateOptions specifies the parameters for updating a task.
type TaskUpdateOptions struct {
	Title              *string  `json:"title,omitempty"`
	Description        *string  `json:"description,omitempty"`
	Priority           *string  `json:"priority,omitempty"`
	Labels             []string `json:"labels,omitempty"`
	SkillID            *string  `json:"skillId,omitempty"`
	SkillName          *string  `json:"skillName,omitempty"`
	ExecutionSkillID   *string  `json:"executionSkillId,omitempty"`
	ExecutionSkillName *string  `json:"executionSkillName,omitempty"`
}

// TaskMoveOptions specifies the target column and position when moving a task.
type TaskMoveOptions struct {
	Column   string `json:"column"`
	Position int    `json:"position"`
}

// TaskListOptions specifies filters for listing tasks.
type TaskListOptions struct {
	CodespaceID string
	Column      string
	Limit       int
	Offset      int
}

// SessionListOptions specifies filters for listing sessions.
type SessionListOptions struct {
	CodespaceID string
	Status      string
	AgentID     string
	Limit       int
	Offset      int
}
