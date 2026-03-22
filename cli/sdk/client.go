package sdk

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultUserAgent = "agentpane-go-sdk/1.0"
	defaultTimeout   = 30 * time.Second
)

// Config holds the configuration for connecting to the AgentPane API.
type Config struct {
	// Address is the base URL of the AgentPane server (e.g., "http://localhost:3001").
	Address string
	// Token is the authentication token for API requests.
	Token string
	// UserAgent is the User-Agent header value. Defaults to "agentpane-go-sdk/1.0".
	UserAgent string
}

// Client provides access to the AgentPane REST API.
type Client struct {
	config Config
	http   *http.Client

	// Codespaces provides operations on codespace resources.
	Codespaces *CodespaceService
	// Tasks provides operations on task resources.
	Tasks *TaskService
	// Agents provides operations on agent resources.
	Agents *AgentService
	// Sessions provides operations on session resources.
	Sessions *SessionService
	// Worktrees provides operations on worktree resources.
	Worktrees *WorktreeService
	// Folders provides operations on project folder resources.
	Projects *ProjectService
	// Teams provides operations on team resources.
	Teams *TeamService
	// Git provides git operations for codespaces.
	Git *GitService
	// Health provides server health check operations.
	Health *HealthService
}

// NewClient creates a new AgentPane API client with the given configuration.
// It validates that the address is provided and initializes all service clients.
func NewClient(cfg Config) (*Client, error) {
	if cfg.Address == "" {
		return nil, fmt.Errorf("sdk: address is required")
	}

	// Normalize address: remove trailing slash
	cfg.Address = strings.TrimRight(cfg.Address, "/")

	if cfg.UserAgent == "" {
		cfg.UserAgent = defaultUserAgent
	}

	c := &Client{
		config: cfg,
		http: &http.Client{
			Timeout: defaultTimeout,
		},
	}

	c.Codespaces = &CodespaceService{client: c}
	c.Tasks = &TaskService{client: c}
	c.Agents = &AgentService{client: c}
	c.Sessions = &SessionService{client: c}
	c.Worktrees = &WorktreeService{client: c}
	c.Projects = &ProjectService{client: c}
	c.Teams = &TeamService{client: c}
	c.Git = &GitService{client: c}
	c.Health = &HealthService{client: c}

	return c, nil
}

// apiResponse represents the standard API response envelope.
// Successful responses: { ok: true, data: ... }
// Error responses:      { ok: false, error: { code, message } }
type apiResponse struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// do executes an HTTP request and decodes the response into result.
// If result is nil, the response body is read but not decoded (useful for DELETE).
func (c *Client) do(ctx context.Context, method, path string, body interface{}, result interface{}) error {
	url := c.config.Address + path

	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("sdk: failed to marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return fmt.Errorf("sdk: failed to create request: %w", err)
	}

	req.Header.Set("User-Agent", c.config.UserAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if c.config.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.config.Token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("sdk: request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("sdk: failed to read response body: %w", err)
	}

	// Handle non-JSON error responses (e.g., 502 from a proxy)
	if resp.StatusCode >= 400 {
		var envelope apiResponse
		if err := json.Unmarshal(respBody, &envelope); err == nil && envelope.Error != nil {
			return &APIError{
				StatusCode: resp.StatusCode,
				Code:       envelope.Error.Code,
				Message:    envelope.Error.Message,
			}
		}
		return &APIError{
			StatusCode: resp.StatusCode,
			Message:    string(respBody),
		}
	}

	// For 204 No Content, nothing to decode
	if resp.StatusCode == http.StatusNoContent || len(respBody) == 0 {
		return nil
	}

	// Parse the response envelope
	var envelope apiResponse
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		return fmt.Errorf("sdk: failed to decode response: %w", err)
	}

	if !envelope.OK && envelope.Error != nil {
		return &APIError{
			StatusCode: resp.StatusCode,
			Code:       envelope.Error.Code,
			Message:    envelope.Error.Message,
		}
	}

	// Decode data into result if requested
	if result != nil && len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, result); err != nil {
			return fmt.Errorf("sdk: failed to decode response data: %w", err)
		}
	}

	return nil
}

// get performs an HTTP GET request.
func (c *Client) get(ctx context.Context, path string, result interface{}) error {
	return c.do(ctx, http.MethodGet, path, nil, result)
}

// post performs an HTTP POST request.
func (c *Client) post(ctx context.Context, path string, body interface{}, result interface{}) error {
	return c.do(ctx, http.MethodPost, path, body, result)
}

// put performs an HTTP PUT request.
func (c *Client) put(ctx context.Context, path string, body interface{}, result interface{}) error {
	return c.do(ctx, http.MethodPut, path, body, result)
}

// patch performs an HTTP PATCH request.
func (c *Client) patch(ctx context.Context, path string, body interface{}, result interface{}) error {
	return c.do(ctx, http.MethodPatch, path, body, result)
}

// del performs an HTTP DELETE request.
func (c *Client) del(ctx context.Context, path string) error {
	return c.do(ctx, http.MethodDelete, path, nil, nil)
}
