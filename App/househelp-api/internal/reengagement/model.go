package reengagement

import "time"

const (
	ScenarioMoppingDropoff  = "mopping_dropoff"
	ScenarioCartAbandonment = "cart_abandonment"
)

type Candidate struct {
	UserID      string
	WindowStart time.Time
	ServiceName string
	CartCount   int
}
