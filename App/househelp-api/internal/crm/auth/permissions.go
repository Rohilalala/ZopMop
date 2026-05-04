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
	"workers.approve":        RoleAdmin,
	"workers.reject":         RoleAdmin,
	"workers.suspend":        RoleAdmin,
	"workers.unsuspend":      RoleAdmin,
	"workers.force_offline":  RoleAdmin,
	"workers.set_categories": RoleAdmin,
	"workers.add_note":       RoleSupport,

	// orders
	"orders.cancel":   RoleAdmin,
	"orders.complete": RoleAdmin,
	"orders.reassign": RoleAdmin,

	// refunds
	"refunds.approve_full":    RoleSupport, // full refund — support OK
	"refunds.approve_partial": RoleAdmin,   // partial — admin only
	"refunds.reject":          RoleSupport,

	// promos
	"promos.create": RoleAdmin,
	"promos.update": RoleAdmin,
	"promos.toggle": RoleAdmin,

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

	// templates
	"templates.create": RoleAdmin,
	"templates.update": RoleAdmin,
	"templates.delete": RoleAdmin,

	// support tickets
	"tickets.resolve": RoleSupport,

	// growth — waitlist (default admin)
	"waitlist.create": RoleAdmin,

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
