package sdk

import "context"

// TeamService provides operations on team resources.
type TeamService struct {
	client *Client
}

// List returns all teams.
func (s *TeamService) List(ctx context.Context) ([]Team, error) {
	var result []Team
	if err := s.client.get(ctx, "/api/teams", &result); err != nil {
		return nil, err
	}
	return result, nil
}
