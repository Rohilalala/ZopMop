// App-level feature gates. Compile-time switches for features that ship in the
// binary but aren't ready for launch — flip to true (or wire to a remote flag)
// when rolling out.

// Roomies (shared household groups, vault, cost splitting). Disabled for
// initial release; planned as a post-launch update.
export const ROOMIES_ENABLED = false;
