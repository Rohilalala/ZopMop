package services

import "context"

// Catalog is the business-logic layer for the services catalog.
// It is named Catalog to avoid collision with the Service domain model.
type Catalog struct {
	repo *Repository
}

// NewService creates a new services catalog service.
func NewService(repo *Repository) *Catalog {
	return &Catalog{repo: repo}
}

// List returns all active services.
func (c *Catalog) List(ctx context.Context) ([]Service, error) {
	return c.repo.List(ctx)
}

// GetDetails returns full service details including includes, excludes, and steps.
func (c *Catalog) GetDetails(ctx context.Context, serviceID string) (*ServiceDetails, error) {
	return c.repo.GetDetails(ctx, serviceID)
}

// GetAddons returns add-on services for a given base service.
func (c *Catalog) GetAddons(ctx context.Context, serviceID string) ([]ServiceAddon, error) {
	return c.repo.GetAddons(ctx, serviceID)
}
