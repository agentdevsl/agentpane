// Package command implements all CLI commands for the AgentPane CLI.
//
// Each command embeds the shared Meta struct which provides access to
// the SDK client, global flags, and output formatting.
package command

import (
	"flag"
	"fmt"
	"os"
	"sync"

	"github.com/agentdevsl/agentpane/cli/internal/logging"
	"github.com/agentdevsl/agentpane/cli/sdk"
)

// Meta contains shared configuration and dependencies used by all commands.
// It handles global flag parsing, client initialization, and codespace resolution.
type Meta struct {
	// client is the lazily-initialized SDK client.
	client *sdk.Client
	mu     sync.Mutex

	// codespaceID is the resolved codespace identifier.
	codespaceID string

	// jsonOutput indicates whether output should be formatted as JSON.
	jsonOutput bool

	// Global flag values.
	flagToken     string
	flagAddress   string
	flagCodespace string
	flagJSON      bool
}

// NewMeta creates a new Meta with default values.
func NewMeta() *Meta {
	return &Meta{}
}

// FlagSet creates a new flag.FlagSet with the given name and registers
// the global flags (-token, -address, -codespace, -json) on it.
func (m *Meta) FlagSet(name string) *flag.FlagSet {
	f := flag.NewFlagSet(name, flag.ContinueOnError)

	f.StringVar(&m.flagToken, "token", "", "API token (env: AP_TOKEN)")
	f.StringVar(&m.flagAddress, "address", "", "API base URL (env: AP_ADDRESS, default: http://localhost:3001)")
	f.StringVar(&m.flagCodespace, "codespace", "", "Codespace ID (env: AP_CODESPACE)")
	f.BoolVar(&m.flagJSON, "json", false, "Output as JSON")

	return f
}

// Client returns a lazily-initialized SDK client. It resolves configuration
// from flags first, then environment variables, then defaults.
func (m *Meta) Client() (*sdk.Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.client != nil {
		return m.client, nil
	}

	// Resolve address: flag > env > default.
	address := m.flagAddress
	if address == "" {
		address = os.Getenv("AP_ADDRESS")
	}
	if address == "" {
		address = "http://localhost:3001"
	}

	// Resolve token: flag > env.
	token := m.flagToken
	if token == "" {
		token = os.Getenv("AP_TOKEN")
	}

	logging.L().Debug("initializing SDK client", "address", address, "hasToken", token != "")

	client, err := sdk.NewClient(sdk.Config{
		Address: address,
		Token:   token,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create client: %w", err)
	}

	m.client = client
	return m.client, nil
}

// CodespaceID resolves the codespace identifier from the -codespace flag
// or the AP_CODESPACE environment variable.
func (m *Meta) CodespaceID() string {
	if m.flagCodespace != "" {
		return m.flagCodespace
	}
	if env := os.Getenv("AP_CODESPACE"); env != "" {
		return env
	}
	return ""
}

// JSONOutput returns true if the -json flag was set.
func (m *Meta) JSONOutput() bool {
	return m.flagJSON
}
