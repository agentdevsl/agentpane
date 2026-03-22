package sdk

import (
	"errors"
	"fmt"
	"testing"
)

func TestAPIError_Error_WithCode(t *testing.T) {
	err := &APIError{
		StatusCode: 404,
		Code:       "NOT_FOUND",
		Message:    "Resource not found",
	}
	want := "agentpane api error 404 (NOT_FOUND): Resource not found"
	if err.Error() != want {
		t.Errorf("expected %q, got %q", want, err.Error())
	}
}

func TestAPIError_Error_WithoutCode(t *testing.T) {
	err := &APIError{
		StatusCode: 502,
		Message:    "Bad Gateway",
	}
	want := "agentpane api error 502: Bad Gateway"
	if err.Error() != want {
		t.Errorf("expected %q, got %q", want, err.Error())
	}
}

func TestAPIError_ImplementsError(t *testing.T) {
	var err error = &APIError{StatusCode: 500, Code: "INTERNAL", Message: "fail"}
	if err == nil {
		t.Fatal("expected non-nil error")
	}
}

func TestIsNotFound_True(t *testing.T) {
	err := &APIError{StatusCode: 404, Code: "NOT_FOUND", Message: "not found"}
	if !IsNotFound(err) {
		t.Error("expected IsNotFound to return true for 404")
	}
}

func TestIsNotFound_FalseForOtherStatus(t *testing.T) {
	err := &APIError{StatusCode: 400, Code: "VALIDATION_ERROR", Message: "bad request"}
	if IsNotFound(err) {
		t.Error("expected IsNotFound to return false for 400")
	}
}

func TestIsNotFound_FalseForNonAPIError(t *testing.T) {
	err := errors.New("some other error")
	if IsNotFound(err) {
		t.Error("expected IsNotFound to return false for non-APIError")
	}
}

func TestIsUnauthorized_True(t *testing.T) {
	err := &APIError{StatusCode: 401, Code: "UNAUTHORIZED", Message: "unauthorized"}
	if !IsUnauthorized(err) {
		t.Error("expected IsUnauthorized to return true for 401")
	}
}

func TestIsUnauthorized_FalseForOtherStatus(t *testing.T) {
	err := &APIError{StatusCode: 403, Code: "FORBIDDEN", Message: "forbidden"}
	if IsUnauthorized(err) {
		t.Error("expected IsUnauthorized to return false for 403")
	}
}

func TestIsUnauthorized_FalseForNonAPIError(t *testing.T) {
	err := errors.New("network error")
	if IsUnauthorized(err) {
		t.Error("expected IsUnauthorized to return false for non-APIError")
	}
}

func TestIsForbidden_True(t *testing.T) {
	err := &APIError{StatusCode: 403, Code: "FORBIDDEN", Message: "forbidden"}
	if !IsForbidden(err) {
		t.Error("expected IsForbidden to return true for 403")
	}
}

func TestIsForbidden_FalseForOtherStatus(t *testing.T) {
	err := &APIError{StatusCode: 401, Code: "UNAUTHORIZED", Message: "unauthorized"}
	if IsForbidden(err) {
		t.Error("expected IsForbidden to return false for 401")
	}
}

func TestIsForbidden_FalseForNonAPIError(t *testing.T) {
	err := errors.New("timeout")
	if IsForbidden(err) {
		t.Error("expected IsForbidden to return false for non-APIError")
	}
}

func TestIsConflict_True(t *testing.T) {
	err := &APIError{StatusCode: 409, Code: "CONFLICT", Message: "conflict"}
	if !IsConflict(err) {
		t.Error("expected IsConflict to return true for 409")
	}
}

func TestIsConflict_FalseForOtherStatus(t *testing.T) {
	err := &APIError{StatusCode: 500, Code: "INTERNAL_ERROR", Message: "server error"}
	if IsConflict(err) {
		t.Error("expected IsConflict to return false for 500")
	}
}

func TestIsConflict_FalseForNonAPIError(t *testing.T) {
	err := errors.New("io error")
	if IsConflict(err) {
		t.Error("expected IsConflict to return false for non-APIError")
	}
}

func TestIsValidationError_True_400(t *testing.T) {
	err := &APIError{StatusCode: 400, Code: "VALIDATION_ERROR", Message: "invalid input"}
	if !IsValidationError(err) {
		t.Error("expected IsValidationError to return true for 400")
	}
}

func TestIsValidationError_True_422(t *testing.T) {
	err := &APIError{StatusCode: 422, Code: "VALIDATION_ERROR", Message: "unprocessable"}
	if !IsValidationError(err) {
		t.Error("expected IsValidationError to return true for 422")
	}
}

func TestIsValidationError_FalseForOtherStatus(t *testing.T) {
	err := &APIError{StatusCode: 404, Code: "NOT_FOUND", Message: "not found"}
	if IsValidationError(err) {
		t.Error("expected IsValidationError to return false for 404")
	}
}

func TestIsValidationError_FalseForNonAPIError(t *testing.T) {
	err := errors.New("parse error")
	if IsValidationError(err) {
		t.Error("expected IsValidationError to return false for non-APIError")
	}
}

func TestIsNotFound_NilError(t *testing.T) {
	if IsNotFound(nil) {
		t.Error("expected IsNotFound to return false for nil")
	}
}

func TestIsUnauthorized_NilError(t *testing.T) {
	if IsUnauthorized(nil) {
		t.Error("expected IsUnauthorized to return false for nil")
	}
}

func TestIsForbidden_NilError(t *testing.T) {
	if IsForbidden(nil) {
		t.Error("expected IsForbidden to return false for nil")
	}
}

func TestIsConflict_NilError(t *testing.T) {
	if IsConflict(nil) {
		t.Error("expected IsConflict to return false for nil")
	}
}

func TestIsValidationError_NilError(t *testing.T) {
	if IsValidationError(nil) {
		t.Error("expected IsValidationError to return false for nil")
	}
}

// --- Wrapped error tests (errors.As through fmt.Errorf %w) ---

func TestIsNotFound_WrappedError(t *testing.T) {
	inner := &APIError{StatusCode: 404, Code: "NOT_FOUND", Message: "gone"}
	wrapped := fmt.Errorf("context: %w", inner)
	if !IsNotFound(wrapped) {
		t.Error("expected IsNotFound to return true for wrapped 404 APIError")
	}
}

func TestIsUnauthorized_WrappedError(t *testing.T) {
	inner := &APIError{StatusCode: 401, Code: "UNAUTHORIZED", Message: "bad token"}
	wrapped := fmt.Errorf("auth failed: %w", inner)
	if !IsUnauthorized(wrapped) {
		t.Error("expected IsUnauthorized to return true for wrapped 401 APIError")
	}
}

func TestIsForbidden_WrappedError(t *testing.T) {
	inner := &APIError{StatusCode: 403, Code: "FORBIDDEN", Message: "no access"}
	wrapped := fmt.Errorf("access denied: %w", inner)
	if !IsForbidden(wrapped) {
		t.Error("expected IsForbidden to return true for wrapped 403 APIError")
	}
}

func TestIsConflict_WrappedError(t *testing.T) {
	inner := &APIError{StatusCode: 409, Code: "CONFLICT", Message: "duplicate"}
	wrapped := fmt.Errorf("create failed: %w", inner)
	if !IsConflict(wrapped) {
		t.Error("expected IsConflict to return true for wrapped 409 APIError")
	}
}

func TestIsValidationError_WrappedError(t *testing.T) {
	inner := &APIError{StatusCode: 422, Code: "VALIDATION_ERROR", Message: "bad input"}
	wrapped := fmt.Errorf("validation: %w", inner)
	if !IsValidationError(wrapped) {
		t.Error("expected IsValidationError to return true for wrapped 422 APIError")
	}
}

func TestIsNotFound_DoubleWrappedError(t *testing.T) {
	inner := &APIError{StatusCode: 404, Code: "NOT_FOUND", Message: "gone"}
	wrapped := fmt.Errorf("layer1: %w", fmt.Errorf("layer2: %w", inner))
	if !IsNotFound(wrapped) {
		t.Error("expected IsNotFound to return true for double-wrapped 404 APIError")
	}
}

func TestIsNotFound_WrappedNonAPIError(t *testing.T) {
	inner := errors.New("plain error")
	wrapped := fmt.Errorf("wrapped: %w", inner)
	if IsNotFound(wrapped) {
		t.Error("expected IsNotFound to return false for wrapped non-APIError")
	}
}

func TestIsUnauthorized_WrappedWrongStatus(t *testing.T) {
	inner := &APIError{StatusCode: 404, Code: "NOT_FOUND", Message: "not auth"}
	wrapped := fmt.Errorf("wrapped: %w", inner)
	if IsUnauthorized(wrapped) {
		t.Error("expected IsUnauthorized to return false for wrapped 404 (not 401)")
	}
}
