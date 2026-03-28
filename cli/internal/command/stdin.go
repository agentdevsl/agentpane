package command

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// ReadStdin reads JSON from stdin and decodes it into the target.
// Returns true if stdin was piped (not a terminal) and data was read.
// Returns false if stdin is a terminal or empty.
func ReadStdin(target interface{}) (bool, error) {
	stat, err := os.Stdin.Stat()
	if err != nil {
		return false, nil
	}
	if (stat.Mode() & os.ModeCharDevice) != 0 {
		return false, nil // stdin is a terminal, not piped
	}
	data, err := io.ReadAll(os.Stdin)
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
