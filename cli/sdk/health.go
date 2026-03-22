package sdk

import "context"

// HealthService provides operations for checking server health.
type HealthService struct {
	client *Client
}

// Check performs a health check against the AgentPane server.
// It returns the server and database status.
func (s *HealthService) Check(ctx context.Context) (*HealthStatus, error) {
	var result HealthStatus
	if err := s.client.get(ctx, "/api/health", &result); err != nil {
		return nil, err
	}
	return &result, nil
}
