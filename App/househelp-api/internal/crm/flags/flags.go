// Package flags is the CRM-side feature-flag store. The user-facing app reads
// flags from Redis hash <namespace>flags; this package writes there and also
// snapshots every change to crm_config_snapshots for rollback.
package flags

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// FlagType enumerates the supported flag value shapes.
type FlagType string

const (
	TypeBool   FlagType = "bool"
	TypeNumber FlagType = "number"
	TypeString FlagType = "string"
	TypeEnum   FlagType = "enum"
	TypeJSON   FlagType = "json"
)

// FlagDef is the static definition of a flag. Maintained in code; the value
// lives in Redis. The CRM UI uses defs to render the right input control.
type FlagDef struct {
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Category    string   `json:"category"`
	Type        FlagType `json:"type"`
	Default     any      `json:"default"`
	Min         *float64 `json:"min,omitempty"`
	Max         *float64 `json:"max,omitempty"`
	EnumOptions []string `json:"enum_options,omitempty"`
}

// Flag is a def + current value (loaded from Redis).
type Flag struct {
	Def   FlagDef `json:"def"`
	Value any     `json:"value"`
}

// Service handles flag reads / writes / snapshots.
type Service struct {
	db        *pgxpool.Pool
	rdb       *redis.Client
	namespace string
	defs      map[string]FlagDef
}

// NewService constructs the flags Service. defs is the static flag registry.
func NewService(db *pgxpool.Pool, rdb *redis.Client, namespace string, defs []FlagDef) *Service {
	m := make(map[string]FlagDef, len(defs))
	for _, d := range defs {
		m[d.Key] = d
	}
	return &Service{db: db, rdb: rdb, namespace: namespace, defs: m}
}

func (s *Service) hashKey() string {
	return s.namespace + "flags"
}

// List returns all flags w/ current values, falling back to def.Default if
// the value is absent in Redis (i.e. flag never set).
func (s *Service) List(ctx context.Context) ([]Flag, error) {
	values, err := s.rdb.HGetAll(ctx, s.hashKey()).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, fmt.Errorf("redis hgetall flags: %w", err)
	}

	out := make([]Flag, 0, len(s.defs))
	for _, def := range s.defs {
		f := Flag{Def: def, Value: def.Default}
		if raw, ok := values[def.Key]; ok && raw != "" {
			var v any
			if err := json.Unmarshal([]byte(raw), &v); err == nil {
				f.Value = v
			}
		}
		out = append(out, f)
	}
	return out, nil
}

// Get returns one flag.
func (s *Service) Get(ctx context.Context, key string) (*Flag, error) {
	def, ok := s.defs[key]
	if !ok {
		return nil, fmt.Errorf("unknown flag: %s", key)
	}
	raw, err := s.rdb.HGet(ctx, s.hashKey(), key).Result()
	f := Flag{Def: def, Value: def.Default}
	if errors.Is(err, redis.Nil) {
		return &f, nil
	}
	if err != nil {
		return nil, fmt.Errorf("redis hget flag: %w", err)
	}
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err == nil {
		f.Value = v
	}
	return &f, nil
}

// Set validates a new value against the def then writes it to Redis. The
// caller is responsible for persisting the snapshot via SaveSnapshot.
func (s *Service) Set(ctx context.Context, key string, value any) (oldValue any, err error) {
	def, ok := s.defs[key]
	if !ok {
		return nil, fmt.Errorf("unknown flag: %s", key)
	}
	if err := validateValue(def, value); err != nil {
		return nil, err
	}

	// Read the prior value for the audit/snapshot diff.
	current, getErr := s.Get(ctx, key)
	if getErr == nil {
		oldValue = current.Value
	}

	bytes, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("marshal flag value: %w", err)
	}
	if err := s.rdb.HSet(ctx, s.hashKey(), key, string(bytes)).Err(); err != nil {
		return nil, fmt.Errorf("redis hset flag: %w", err)
	}
	return oldValue, nil
}

// SaveSnapshot persists the entire current flag tree to crm_config_snapshots.
// Diff is the per-flag before/after for the change that triggered it.
func (s *Service) SaveSnapshot(ctx context.Context, adminID, adminEmail, reason string, diff map[string]any) error {
	flags, err := s.List(ctx)
	if err != nil {
		return err
	}
	flagsMap := make(map[string]any, len(flags))
	for _, f := range flags {
		flagsMap[f.Def.Key] = f.Value
	}
	flagsJSON, err := json.Marshal(flagsMap)
	if err != nil {
		return fmt.Errorf("marshal flags: %w", err)
	}
	diffJSON, _ := json.Marshal(diff)

	_, err = s.db.Exec(ctx, `
		INSERT INTO crm_config_snapshots (admin_id, admin_email, reason, flags_json, diff_json)
		VALUES ($1, $2, $3, $4, $5)
	`, nilIfEmpty(adminID), nilIfEmpty(adminEmail), nilIfEmpty(reason), flagsJSON, diffJSON)
	if err != nil {
		return fmt.Errorf("insert snapshot: %w", err)
	}
	return nil
}

// Snapshot is the row shape returned to the UI's rollback list.
type Snapshot struct {
	ID         string          `json:"id"`
	AdminID    *string         `json:"admin_id,omitempty"`
	AdminEmail *string         `json:"admin_email,omitempty"`
	Reason     *string         `json:"reason,omitempty"`
	FlagsJSON  json.RawMessage `json:"flags"`
	DiffJSON   json.RawMessage `json:"diff,omitempty"`
	CreatedAt  time.Time       `json:"created_at"`
}

// ListSnapshots returns the most recent N snapshots.
func (s *Service) ListSnapshots(ctx context.Context, limit int) ([]Snapshot, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.Query(ctx, `
		SELECT id::text, admin_id::text, admin_email, reason, flags_json, diff_json, created_at
		FROM crm_config_snapshots
		ORDER BY created_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("list snapshots: %w", err)
	}
	defer rows.Close()

	out := []Snapshot{}
	for rows.Next() {
		var sn Snapshot
		if err := rows.Scan(&sn.ID, &sn.AdminID, &sn.AdminEmail, &sn.Reason, &sn.FlagsJSON, &sn.DiffJSON, &sn.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan snapshot: %w", err)
		}
		out = append(out, sn)
	}
	return out, rows.Err()
}

// Rollback applies a snapshot back to Redis, then writes a new snapshot
// recording the rollback itself.
func (s *Service) Rollback(ctx context.Context, snapshotID, adminID, adminEmail string) error {
	var flagsJSON []byte
	err := s.db.QueryRow(ctx, `
		SELECT flags_json FROM crm_config_snapshots WHERE id = $1::uuid
	`, snapshotID).Scan(&flagsJSON)
	if err != nil {
		return fmt.Errorf("snapshot not found: %w", err)
	}

	var snapFlags map[string]any
	if err := json.Unmarshal(flagsJSON, &snapFlags); err != nil {
		return fmt.Errorf("decode snapshot: %w", err)
	}

	pipe := s.rdb.TxPipeline()
	pipe.Del(ctx, s.hashKey())
	for k, v := range snapFlags {
		bytes, _ := json.Marshal(v)
		pipe.HSet(ctx, s.hashKey(), k, string(bytes))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("apply snapshot: %w", err)
	}

	return s.SaveSnapshot(ctx, adminID, adminEmail, "rollback to "+snapshotID, map[string]any{
		"rollback_to": snapshotID,
	})
}

func validateValue(def FlagDef, v any) error {
	switch def.Type {
	case TypeBool:
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("flag %s expects bool", def.Key)
		}
	case TypeNumber:
		f, ok := toFloat(v)
		if !ok {
			return fmt.Errorf("flag %s expects number", def.Key)
		}
		if def.Min != nil && f < *def.Min {
			return fmt.Errorf("flag %s value %v below min %v", def.Key, f, *def.Min)
		}
		if def.Max != nil && f > *def.Max {
			return fmt.Errorf("flag %s value %v above max %v", def.Key, f, *def.Max)
		}
	case TypeString:
		if _, ok := v.(string); !ok {
			return fmt.Errorf("flag %s expects string", def.Key)
		}
	case TypeEnum:
		s, ok := v.(string)
		if !ok {
			return fmt.Errorf("flag %s expects string from enum", def.Key)
		}
		for _, opt := range def.EnumOptions {
			if opt == s {
				return nil
			}
		}
		return fmt.Errorf("flag %s value %q not in enum", def.Key, s)
	case TypeJSON:
		// any JSON-encodable value is acceptable
	default:
		return fmt.Errorf("unknown flag type %s", def.Type)
	}
	return nil
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
