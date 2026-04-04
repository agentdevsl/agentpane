package command

import "testing"

func TestMaskValue(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"", "****"},
		{"ab", "****"},
		{"abcd", "****"},
		{"abcde", "abcd****"},
		{"tfc-abc123", "tfc-****"},
		{"us-east-1", "us-e****"},
	}

	for _, tt := range tests {
		got := maskValue(tt.input)
		if got != tt.want {
			t.Errorf("maskValue(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}
