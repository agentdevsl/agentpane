package sdk

import "testing"

func TestColumnConstants(t *testing.T) {
	tests := []struct {
		name     string
		constant string
		expected string
	}{
		{"ColumnBacklog", ColumnBacklog, "backlog"},
		{"ColumnQueued", ColumnQueued, "queued"},
		{"ColumnInProgress", ColumnInProgress, "in_progress"},
		{"ColumnWaitingApproval", ColumnWaitingApproval, "waiting_approval"},
		{"ColumnVerified", ColumnVerified, "verified"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.constant != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, tt.constant)
			}
		})
	}
}

func TestPriorityConstants(t *testing.T) {
	tests := []struct {
		name     string
		constant string
		expected string
	}{
		{"PriorityHigh", PriorityHigh, "high"},
		{"PriorityMedium", PriorityMedium, "medium"},
		{"PriorityLow", PriorityLow, "low"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.constant != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, tt.constant)
			}
		})
	}
}

func TestAgentStatusConstants(t *testing.T) {
	tests := []struct {
		name     string
		constant string
		expected string
	}{
		{"AgentStatusIdle", AgentStatusIdle, "idle"},
		{"AgentStatusStarting", AgentStatusStarting, "starting"},
		{"AgentStatusPlanning", AgentStatusPlanning, "planning"},
		{"AgentStatusRunning", AgentStatusRunning, "running"},
		{"AgentStatusPaused", AgentStatusPaused, "paused"},
		{"AgentStatusError", AgentStatusError, "error"},
		{"AgentStatusCompleted", AgentStatusCompleted, "completed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.constant != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, tt.constant)
			}
		})
	}
}

func TestSessionStatusConstants(t *testing.T) {
	tests := []struct {
		name     string
		constant string
		expected string
	}{
		{"SessionStatusIdle", SessionStatusIdle, "idle"},
		{"SessionStatusInitializing", SessionStatusInitializing, "initializing"},
		{"SessionStatusActive", SessionStatusActive, "active"},
		{"SessionStatusPaused", SessionStatusPaused, "paused"},
		{"SessionStatusClosing", SessionStatusClosing, "closing"},
		{"SessionStatusClosed", SessionStatusClosed, "closed"},
		{"SessionStatusError", SessionStatusError, "error"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.constant != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, tt.constant)
			}
		})
	}
}
