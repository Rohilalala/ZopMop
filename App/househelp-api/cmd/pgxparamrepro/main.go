package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

func tryURL(url string) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		fmt.Printf("[%s] connect err: %v\n", url, err)
		return
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		fmt.Printf("[%s] ping err: %v\n", url, err)
		return
	}
	fmt.Printf("[%s] connected. DefaultQueryExecMode=%v\n", url, pool.Config().ConnConfig.DefaultQueryExecMode)

	// Mimic FindReplacementPro shape: params $1,$3,$4 used, $2 skipped.
	// Use the same arg count (4) as the real call site.
	var id string
	q := `SELECT 'x'::text WHERE 'a'::text <> $1 AND now()::date = $4 AND 'b'::text <> $3`
	err = pool.QueryRow(ctx, q, "p1", "p2-unused", "p3", "2026-06-11").Scan(&id)
	fmt.Printf("[%s] skip-$2 query => id=%q err=%v\n", url, id, err)
}

func main() {
	urls := []string{
		"postgres://househelp:localdev123@localhost:5433/househelp_db",
		"postgres://househelp:localdev123@localhost:5432/househelp_db",
	}
	if len(os.Args) > 1 {
		urls = []string{os.Args[1]}
	}
	for _, u := range urls {
		tryURL(u)
	}
}
