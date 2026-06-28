package auth

const (
	RoleViewer     = "viewer"
	RoleSupport    = "support"
	RoleAdmin      = "admin"
	RoleSuperadmin = "superadmin"
)

var roleRank = map[string]int{
	RoleViewer:     0,
	RoleSupport:    1,
	RoleAdmin:      2,
	RoleSuperadmin: 3,
}

// permissions maps a permission key to the MINIMUM role required.
// Higher roles inherit lower role permissions via roleRank.
// Unknown keys deny by default.
var permissions = map[string]string{
	// users
	"users.suspend":   RoleAdmin,
	"users.unsuspend": RoleAdmin,
	"users.ban":       RoleAdmin,
	"users.unban":     RoleAdmin,
	"users.set_vip":   RoleAdmin,
	"users.add_note":  RoleSupport,

	// workers
	"workers.create":         RoleAdmin,
	"workers.approve":        RoleAdmin,
	"workers.reject":         RoleAdmin,
	"workers.suspend":        RoleAdmin,
	"workers.unsuspend":      RoleAdmin,
	"workers.force_offline":  RoleAdmin,
	"workers.set_categories": RoleAdmin,
	"workers.add_note":       RoleSupport,
	"workers.read_pii":       RoleSuperadmin, // unmasked Aadhaar/bank reveal — superadmin only, audited
	"workers.deduct":         RoleAdmin, // manual fortnight deduction
	"workers.update":         RoleAdmin, // generic update gate (leave allocate, etc.)

	// orders
	"orders.cancel":   RoleAdmin,
	"orders.complete": RoleAdmin,
	"orders.reassign": RoleAdmin,
	"orders.add_note": RoleSupport,

	// refunds
	"refunds.approve_full":    RoleSupport, // full refund — support OK
	"refunds.approve_partial": RoleAdmin,   // partial — admin only
	"refunds.reject":          RoleSupport,

	// promos
	"promos.create": RoleAdmin,
	"promos.update": RoleAdmin,
	"promos.toggle": RoleAdmin,

	// catalog (service categories — price/MRP/active toggle). Edits are
	// business-critical (they change what customers pay), so writes are
	// admin-gated like promos/localities.
	"catalog.update": RoleAdmin,

	// banners
	"banners.create":  RoleAdmin,
	"banners.update":  RoleAdmin,
	"banners.delete":  RoleAdmin,
	"banners.reorder": RoleAdmin,

	// experiments (A/B)
	"experiments.create":  RoleAdmin,
	"experiments.start":   RoleAdmin,
	"experiments.pause":   RoleAdmin,
	"experiments.stop":    RoleAdmin,
	"experiments.rollout": RoleAdmin,

	// push
	"push.create": RoleSupport,
	"push.send":   RoleSupport,

	// zones
	"zones.create": RoleAdmin,
	"zones.update": RoleAdmin,
	"zones.toggle": RoleAdmin,

	// surge
	"surge.create": RoleAdmin,
	"surge.delete": RoleAdmin,

	// disputes
	"disputes.create":  RoleSupport,
	"disputes.resolve": RoleSupport,

	// incidents
	"incidents.create":  RoleSupport,
	"incidents.resolve": RoleSupport,

	// fraud
	"fraud.review": RoleAdmin,

	// blacklist
	"blacklist.add":    RoleAdmin,
	"blacklist.remove": RoleAdmin,

	// payouts
	"payouts.create":      RoleAdmin,
	"payouts.mark_paid":   RoleAdmin,
	"payouts.mark_failed": RoleAdmin,
	"payouts.recompute":   RoleAdmin,

	// performance flags (open → reviewed | dismissed | escalated)
	"flags.review": RoleAdmin,

	// templates
	"templates.create": RoleAdmin,
	"templates.update": RoleAdmin,
	"templates.delete": RoleAdmin,

	// support tickets
	"tickets.resolve": RoleSupport,

	// growth — waitlist (default admin)
	"waitlist.create": RoleAdmin,

	// leaves
	"leaves.deduct": RoleAdmin, // negative-days allocate (deduction)

	// zone approvals (Phase 11B re-mounted on crm-api)
	"zones.approval.read":    RoleSupport,
	"zones.approval.approve": RoleAdmin,
	"zones.approval.reject":  RoleAdmin,

	// shift-session selfies (go-online / go-offline proof-of-presence). PII —
	// gate at support, same tier as workers.read / zones.approval.read.
	"shift_sessions.read": RoleSupport,

	// SDUI page-config lifecycle (crm-api fronts the bff admin handler).
	// Pushing/blanking the production home screen and widening the action
	// allowlist must be admin-gated; FE gates write/activate at admin.
	"sdui.read":     RoleAdmin,
	"sdui.write":    RoleAdmin,
	"sdui.activate": RoleAdmin,

	// SUPERADMIN-only
	"flags.update":       RoleSuperadmin,
	"flags.rollback":     RoleSuperadmin,
	"webhooks.create":    RoleSuperadmin,
	"webhooks.delete":    RoleSuperadmin,
	"app_version.update": RoleSuperadmin,
	"changelog.publish":  RoleSuperadmin,
	"loyalty.update":     RoleSuperadmin,
	"lost_user.create":   RoleSuperadmin,
	"lost_user.toggle":   RoleSuperadmin,

	// Read permissions (audit NEW-A5-001 / A5-001).
	// Operational reads at RoleViewer (default). Sensitive reads
	// tightened to RoleSupport (PII drawer: users/workers/refunds)
	// and RoleAdmin (forensic + business strategy: audit/flags/webhooks).
	// Mechanism landed in commit e6c9f32; tightening landed in the
	// follow-up commit that closes A5-001.
	"alerts.read":        RoleViewer,
	"alerts.mark_read":   RoleViewer, // per-admin read-state; explicit key so the write is RBAC-gated like every other route (was unguarded)
	"analytics.read":     RoleViewer,
	"app_version.read":   RoleViewer,
	"audit.read":         RoleAdmin, // forensic logs + indirect PII via JSONB
	"banners.read":       RoleViewer,
	"blacklist.read":     RoleViewer,
	"capacity.read":      RoleViewer, // slot-capacity grid (drill-down from localities)
	"catalog.read":       RoleViewer,
	"changelog.read":     RoleViewer,
	"dashboard.read":     RoleViewer,
	"disputes.read":      RoleViewer,
	"experiments.read":   RoleViewer,
	"flags.read":         RoleAdmin, // rollout strategies, surge multipliers, AI prompts
	"fraud.read":         RoleViewer,
	"growth.read":        RoleViewer,
	"healthmetrics.read": RoleViewer,
	"incidents.read":     RoleViewer,
	"leaves.read":        RoleViewer,
	"localities.read":    RoleViewer,
	"localities.create":  RoleAdmin,
	"localities.update":  RoleAdmin,
	"localities.delete":  RoleAdmin,
	"notifications.read": RoleViewer,
	"orders.read":        RoleViewer,
	"payouts.read":       RoleViewer,
	"promos.read":        RoleViewer,
	"refunds.read":       RoleSupport, // customer PII + refund amount
	"surge.read":         RoleViewer,
	"templates.read":     RoleViewer,
	"tickets.read":       RoleViewer,
	"users.read":         RoleSupport, // PII drawer: phone, email, address, LTV
	"webhooks.read":      RoleAdmin,   // vendor URLs + event payloads
	"workers.read":       RoleSupport, // PII + live GPS + earnings
	"zones.read":         RoleViewer,
}

// HasPermission returns true if role meets or exceeds the minimum role for perm.
// Unknown perm keys deny by default.
func HasPermission(role, perm string) bool {
	min, ok := permissions[perm]
	if !ok {
		return false
	}
	roleR, okR := roleRank[role]
	if !okR {
		return false
	}
	return roleR >= roleRank[min]
}

// MinRoleFor returns the minimum role required for perm, or empty string if unknown.
func MinRoleFor(perm string) string {
	return permissions[perm]
}
