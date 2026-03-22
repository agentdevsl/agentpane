// Package output provides formatters for CLI output including tables,
// JSON, and key-value displays.
package output

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// PrintTable prints data as an aligned table to stdout.
// Headers are printed in uppercase. Columns are separated by at least two spaces.
func PrintTable(headers []string, rows [][]string) {
	if len(headers) == 0 {
		return
	}

	// Calculate column widths.
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = len(h)
	}
	for _, row := range rows {
		for i, cell := range row {
			if i < len(widths) && len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}

	// Print header row.
	for i, h := range headers {
		if i > 0 {
			fmt.Print("  ")
		}
		fmt.Printf("%-*s", widths[i], strings.ToUpper(h))
	}
	fmt.Println()

	// Print rows.
	for _, row := range rows {
		for i := 0; i < len(headers); i++ {
			if i > 0 {
				fmt.Print("  ")
			}
			cell := ""
			if i < len(row) {
				cell = row[i]
			}
			fmt.Printf("%-*s", widths[i], cell)
		}
		fmt.Println()
	}
}

// PrintJSON marshals v as indented JSON and writes it to stdout.
// Errors are written to stderr.
func PrintJSON(v interface{}) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error encoding JSON: %s\n", err)
		return
	}
	fmt.Println(string(data))
}

// PrintKeyValue prints a map of key-value pairs aligned on the colon.
// Keys are printed in the order provided by the pairs slice for deterministic output.
func PrintKeyValue(pairs []KeyValue) {
	if len(pairs) == 0 {
		return
	}

	// Find the longest key for alignment.
	maxKey := 0
	for _, kv := range pairs {
		if len(kv.Key) > maxKey {
			maxKey = len(kv.Key)
		}
	}

	for _, kv := range pairs {
		fmt.Printf("%-*s  %s\n", maxKey, kv.Key+":", kv.Value)
	}
}

// KeyValue is an ordered key-value pair for display.
type KeyValue struct {
	Key   string
	Value string
}
