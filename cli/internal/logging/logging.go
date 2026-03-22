// Package logging provides structured logging for the AgentPane CLI.
//
// Log level is controlled by the AP_LOG environment variable.
// Valid values: DEBUG, INFO, WARN, ERROR. Default is OFF (no logging).
package logging

import (
	"os"
	"strings"

	"github.com/hashicorp/go-hclog"
)

// Logger is the global CLI logger instance.
var Logger hclog.Logger

func init() {
	level := hclog.NoLevel
	if env := os.Getenv("AP_LOG"); env != "" {
		switch strings.ToUpper(env) {
		case "DEBUG", "TRACE":
			level = hclog.Debug
		case "INFO":
			level = hclog.Info
		case "WARN":
			level = hclog.Warn
		case "ERROR":
			level = hclog.Error
		}
	}

	Logger = hclog.New(&hclog.LoggerOptions{
		Name:   "agentpane",
		Level:  level,
		Output: os.Stderr,
	})
}

// L returns the global logger.
func L() hclog.Logger {
	return Logger
}
