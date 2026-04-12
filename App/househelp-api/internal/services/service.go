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

// ListAll returns all services including inactive ones (admin use).
func (c *Catalog) ListAll(ctx context.Context) ([]Service, error) {
	return c.repo.ListAll(ctx)
}

// Update applies a partial update to a service category (admin use).
// Returns the updated service record.
func (c *Catalog) Update(ctx context.Context, id string, req AdminUpdateServiceRequest) (*Service, error) {
	return c.repo.Update(ctx, id, req)
}

// Create adds a new service category (admin use).
func (c *Catalog) Create(ctx context.Context, req AdminCreateServiceRequest) (*Service, error) {
	return c.repo.Create(ctx, req)
}

// Delete permanently removes a service category (admin use).
func (c *Catalog) Delete(ctx context.Context, id string) error {
	return c.repo.Delete(ctx, id)
}
