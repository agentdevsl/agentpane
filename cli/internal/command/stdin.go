package command

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// ReadStdin reads JSON from stdin and decodes it into the target.
// Returns true if stdin appeared to be piped (not a terminal), regardless of
// whether data was successfully decoded. The error value should be checked
// when true is returned. Returns false if stdin is a terminal or empty.
func ReadStdin(target any) (bool, error) {
	stat, err := os.Stdin.Stat()
	if err != nil {
		return false, fmt.Errorf("failed to stat stdin: %w", err)
	}
	if (stat.Mode() & os.ModeCharDevice) != 0 {
		return false, nil // stdin is a terminal, not piped
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20)) // 1 MB limit
	if err != nil {
		return true, fmt.Errorf("failed to read stdin: %w", err)
	}
	if len(data) == 0 {
		return false, nil
	}
	if err := json.Unmarshal(data, target); err != nil {
		return true, fmt.Errorf("invalid JSON on stdin: %w", err)
	}
	return true, nil
}
