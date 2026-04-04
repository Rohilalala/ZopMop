package zones

import "context"

// ZoneService is the business layer for service zones.
type ZoneService struct {
	repo *Repository
}

func NewService(repo *Repository) *ZoneService {
	return &ZoneService{repo: repo}
}

// Check returns whether the given coordinates fall within any active zone.
func (s *ZoneService) Check(ctx context.Context, lat, lon float64) (*CheckResponse, error) {
	zone, err := s.repo.CheckServiceability(ctx, lat, lon)
	if err != nil {
		return nil, err
	}
	if zone == nil {
		return &CheckResponse{Serviceable: false}, nil
	}
	return &CheckResponse{
		Serviceable: true,
		ZoneName:    zone.Name,
		City:        zone.City,
	}, nil
}

// ListZones returns all zones (admin).
func (s *ZoneService) ListZones(ctx context.Context) ([]ServiceZone, error) {
	return s.repo.ListZones(ctx)
}
