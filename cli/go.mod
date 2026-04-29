module github.com/agentdevsl/agentpane/cli

go 1.24

require (
	github.com/hashicorp/go-hclog v1.6.3
	github.com/mitchellh/cli v1.1.5
)

require (
	github.com/Masterminds/goutils v1.1.1 // indirect
	github.com/Masterminds/semver/v3 v3.1.1 // indirect
	github.com/Masterminds/sprig/v3 v3.2.1 // indirect
	github.com/armon/go-radix v0.0.0-20180808171621-7fddfc383310 // indirect
	github.com/bgentry/speakeasy v0.1.0 // indirect
	github.com/fatih/color v1.18.0 // indirect
	github.com/google/uuid v1.1.2 // indirect
	github.com/hashicorp/errwrap v1.0.0 // indirect
	github.com/hashicorp/go-multierror v1.0.0 // indirect
	github.com/huandu/xstrings v1.3.2 // indirect
	github.com/imdario/mergo v0.3.11 // indirect
	github.com/mattn/go-colorable v0.1.13 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/mitchellh/copystructure v1.0.0 // indirect
	github.com/mitchellh/reflectwalk v1.0.0 // indirect
	github.com/posener/complete v1.1.1 // indirect
	github.com/shopspring/decimal v1.2.0 // indirect
	github.com/spf13/cast v1.3.1 // indirect
	// Pinned to v0.31.0+ to address GHSA-v778-237x-gjrc (critical: ServerConfig.PublicKeyCallback
	// authorization bypass) plus four high-severity SSH vulnerabilities. The `cli/` directory
	// only uses sprig (templating) which transitively pulls x/crypto for blowfish/scrypt; SSH
	// surface is unused but the bump removes the advisory.
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sys v0.28.0 // indirect
)
