// Command bootstrap prints a SQL INSERT statement for seeding the first CRM
// admin. Pipe its output to psql when ready. The password is hashed with
// bcrypt cost 12 — never logged in plaintext.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

func main() {
	var (
		email    = flag.String("email", "", "admin email (required)")
		name     = flag.String("name", "", "display name (required)")
		password = flag.String("password", "", "plaintext password (required, will be hashed)")
		role     = flag.String("role", "superadmin", "role: superadmin|admin|support|viewer")
	)
	flag.Parse()

	if *email == "" || *name == "" || *password == "" {
		flag.Usage()
		os.Exit(2)
	}
	if len(*password) < 12 {
		fmt.Fprintln(os.Stderr, "[bootstrap] password must be at least 12 characters")
		os.Exit(1)
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(*password), 12)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[bootstrap] bcrypt failed: %v\n", err)
		os.Exit(1)
	}

	emailEsc := strings.ReplaceAll(*email, "'", "''")
	nameEsc := strings.ReplaceAll(*name, "'", "''")
	roleEsc := strings.ReplaceAll(*role, "'", "''")

	fmt.Printf(`-- Run against the production DB to seed the first CRM admin.
INSERT INTO crm_admins (email, password_hash, display_name, role, permissions, is_active)
VALUES ('%s', '%s', '%s', '%s', '["*"]'::jsonb, TRUE);
`, emailEsc, string(hash), nameEsc, roleEsc)
}
