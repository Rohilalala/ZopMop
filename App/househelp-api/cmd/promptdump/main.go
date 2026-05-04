package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/adityarohilla/househelp-api/internal/zop"
)

func main() {
	loc, _ := time.LoadLocation("Asia/Kolkata")
	cases := []struct {
		name string
		when time.Time
		who  string
	}{
		{"1. Aayush, 03:13 IST (instant CLOSED)", time.Date(2026, 5, 4, 3, 13, 0, 0, loc), "Aayush"},
		{"2. Aayush, 10:30 IST (instant OPEN)", time.Date(2026, 5, 4, 10, 30, 0, 0, loc), "Aayush"},
		{"3. anon, 20:00 IST (CLOSED — edge of window)", time.Date(2026, 5, 4, 20, 0, 0, 0, loc), ""},
		{"4. anon, 23:00 IST (CLOSED — late night)", time.Date(2026, 5, 4, 23, 0, 0, 0, loc), ""},
	}
	for _, c := range cases {
		fmt.Println(strings.Repeat("=", 80))
		fmt.Println("SCENARIO " + c.name)
		fmt.Println(strings.Repeat("=", 80))
		staticPrefix, dynamicSuffix := zop.BuildSystemPrompt(c.when, c.who)
		fmt.Println(staticPrefix)
		if dynamicSuffix != "" {
			fmt.Println()
			fmt.Println(dynamicSuffix)
		}
		fmt.Println()
	}
}
