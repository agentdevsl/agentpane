// Package version provides the CLI version string, set at build time via ldflags.
package version

// Version is the current CLI version. Override at build time with:
//
//	go build -ldflags "-X github.com/agentdevsl/agentpane/cli/version.Version=1.0.0"
var Version = "0.1.0"
