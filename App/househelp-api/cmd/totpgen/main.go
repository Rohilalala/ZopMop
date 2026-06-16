// Dev-only: print the current TOTP code for a base32 secret. Matches the CRM
// auth params (pquerna/otp, SHA1, 6 digits, 30s). Usage: go run ./cmd/totpgen <secret>
package main

import (
	"fmt"
	"os"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: totpgen <base32-secret>")
		os.Exit(2)
	}
	now := time.Now()
	code, err := totp.GenerateCodeCustom(os.Args[1], now, totp.ValidateOpts{
		Period:    30,
		Digits:    otp.DigitsSix,
		Algorithm: otp.AlgorithmSHA1,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "generate: %v\n", err)
		os.Exit(1)
	}
	secsLeft := 30 - (now.Unix() % 30)
	fmt.Printf("%s  (valid %ds)\n", code, secsLeft)
}
