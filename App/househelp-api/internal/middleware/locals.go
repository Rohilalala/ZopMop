package middleware

// LocalsKeyUserID is the canonical fiber.Ctx Locals key for the
// authenticated user's ID. All middleware and handlers MUST read/write
// via this constant rather than a string literal.
//
// Background (audit E2D-1): the auth middleware wrote "userID" while the
// idempotency middleware read "user_id". Every authenticated user
// therefore collapsed into the empty-string namespace, and a booking
// POST cached under "idem::<key>" was replayed across users — a live
// cross-user data leak. The constant exists so that drift cannot recur
// silently: changing it changes both the writer and the readers.
const LocalsKeyUserID = "userID"
