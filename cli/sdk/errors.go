package sdk

import "fmt"

// APIError represents an error response from the AgentPane API.
// The API returns errors in the format: { ok: false, error: { code, message } }.
type APIError struct {
	// StatusCode is the HTTP status code of the response.
	StatusCode int `json:"-"`
	// Code is the application-level error code (e.g., "NOT_FOUND", "VALIDATION_ERROR").
	Code string `json:"code"`
	// Message is a human-readable description of the error.
	Message string `json:"message"`
}

// Error implements the error interface.
func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("agentpane api error %d (%s): %s", e.StatusCode, e.Code, e.Message)
	}
	return fmt.Sprintf("agentpane api error %d: %s", e.StatusCode, e.Message)
}

// IsNotFound reports whether the error is a 404 Not Found response.
func IsNotFound(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.StatusCode == 404
	}
	return false
}

// IsUnauthorized reports whether the error is a 401 Unauthorized response.
func IsUnauthorized(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.StatusCode == 401
	}
	return false
}

// IsForbidden reports whether the error is a 403 Forbidden response.
func IsForbidden(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.StatusCode == 403
	}
	return false
}

// IsConflict reports whether the error is a 409 Conflict response.
func IsConflict(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.StatusCode == 409
	}
	return false
}

// IsValidationError reports whether the error is a 400 or 422 validation error.
func IsValidationError(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.StatusCode == 400 || apiErr.StatusCode == 422
	}
	return false
}

// apiErrorResponse represents the raw JSON error envelope from the API.
type apiErrorResponse struct {
	OK    bool `json:"ok"`
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}
