package syncapi

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/constructos/sync-service/internal/auth"
	"github.com/constructos/sync-service/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store applies sync operations. Every method runs inside db.WithTenant, so
// Row Level Security confines it to the caller's tenant.
type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

const diaryColumns = `id, project_id, entry_date::text, weather::text, workforce_count, work_completed,
	delays, safety_notes, created_by, device_id, client_recorded_at, version, change_seq, created_at, updated_at`

func scanDiary(row pgx.Row) (DiaryEntry, error) {
	var e DiaryEntry
	err := row.Scan(&e.ID, &e.ProjectID, &e.EntryDate, &e.Weather, &e.WorkforceCount, &e.WorkCompleted,
		&e.Delays, &e.SafetyNotes, &e.CreatedBy, &e.DeviceID, &e.ClientRecordedAt, &e.Version, &e.ChangeSeq,
		&e.CreatedAt, &e.UpdatedAt)
	return e, err
}

// HasModule reports whether the tenant subscribes to a module.
func (s *Store) HasModule(ctx context.Context, tenantID, module string) (bool, error) {
	var ok bool
	err := db.WithTenant(ctx, s.pool, tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`select coalesce(bool_or($1 = any(active_modules)), false) from tenants`, module).Scan(&ok)
	})
	return ok, err
}

// Apply runs one mutation in its own transaction, so one bad record never
// blocks the rest of a device's backlog.
func (s *Store) Apply(ctx context.Context, p auth.Principal, deviceID string, m Mutation) MutationResult {
	res := MutationResult{ID: m.ID}
	if err := m.Validate(); err != nil {
		res.Status, res.Error = StatusRejected, err.Error()
		return res
	}
	err := db.WithTenant(ctx, s.pool, p.TenantID, func(tx pgx.Tx) error {
		if m.Op == "create" {
			return s.create(ctx, tx, p, deviceID, m, &res)
		}
		return s.update(ctx, tx, deviceID, m, &res)
	})
	if err != nil {
		var pgErr *pgconn.PgError
		switch {
		case errors.As(err, &pgErr) && pgErr.Code == "23503":
			res.Status, res.Error = StatusRejected, "unknown project"
		case errors.As(err, &pgErr) && pgErr.Code == "23514":
			res.Status, res.Error = StatusRejected, "value out of range"
		default:
			res.Status, res.Error = StatusRejected, "internal error"
		}
	}
	return res
}

func (s *Store) create(ctx context.Context, tx pgx.Tx, p auth.Principal, deviceID string, m Mutation, res *MutationResult) error {
	d := m.Data
	var version int
	err := tx.QueryRow(ctx, `
		insert into site_diary_entries
		  (id, tenant_id, project_id, entry_date, weather, workforce_count,
		   work_completed, delays, safety_notes, created_by, device_id, client_recorded_at)
		values ($1, $2, $3, $4::date, $5::weather_condition, $6,
		        coalesce($7, ''), coalesce($8, ''), coalesce($9, ''), $10, $11, $12)
		on conflict (id) do nothing
		returning version`,
		m.ID, p.TenantID, *d.ProjectID, *d.EntryDate, d.Weather, d.WorkforceCount,
		d.WorkCompleted, d.Delays, d.SafetyNotes, p.UserID, deviceID, d.ClientRecordedAt,
	).Scan(&version)
	if err == nil {
		res.Status, res.Version = StatusApplied, version
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	// Conflict on id: either our own earlier push (retry) or an id we cannot see.
	err = tx.QueryRow(ctx, `select version from site_diary_entries where id = $1`, m.ID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		res.Status, res.Error = StatusRejected, "id already in use"
		return nil
	}
	if err != nil {
		return err
	}
	res.Status, res.Version = StatusDuplicate, version
	return nil
}

func (s *Store) update(ctx context.Context, tx pgx.Tx, deviceID string, m Mutation, res *MutationResult) error {
	d := m.Data
	var version int
	err := tx.QueryRow(ctx, `
		update site_diary_entries set
		  entry_date         = coalesce($3::date, entry_date),
		  weather            = coalesce($4::weather_condition, weather),
		  workforce_count    = coalesce($5, workforce_count),
		  work_completed     = coalesce($6, work_completed),
		  delays             = coalesce($7, delays),
		  safety_notes       = coalesce($8, safety_notes),
		  client_recorded_at = coalesce($9, client_recorded_at),
		  device_id          = $10
		where id = $1 and version = $2
		returning version`,
		m.ID, *m.BaseVersion, d.EntryDate, d.Weather, d.WorkforceCount,
		d.WorkCompleted, d.Delays, d.SafetyNotes, d.ClientRecordedAt, deviceID,
	).Scan(&version)
	if err == nil {
		res.Status, res.Version = StatusApplied, version
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	// Optimistic concurrency: someone changed it since the device last pulled.
	// Never overwrite silently; hand the server copy back for the user to resolve.
	current, err := scanDiary(tx.QueryRow(ctx, `select `+diaryColumns+` from site_diary_entries where id = $1`, m.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		res.Status, res.Error = StatusRejected, "entry not found"
		return nil
	}
	if err != nil {
		return err
	}
	res.Status, res.Version, res.ServerRecord = StatusConflict, int(current.Version), &current
	res.Error = "entry changed on the server since your last sync"
	return nil
}

// RecordBatch appends one audit event summarising a push.
func (s *Store) RecordBatch(ctx context.Context, p auth.Principal, deviceID string, summary map[string]int) error {
	payload, _ := json.Marshal(map[string]any{"deviceId": deviceID, "summary": summary})
	return db.WithTenant(ctx, s.pool, p.TenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			insert into audit_events (tenant_id, actor_user_id, action, entity_type, payload)
			values ($1, $2, 'diary.synced', 'sync_batch', $3::jsonb)`, p.TenantID, p.UserID, string(payload))
		return err
	})
}

// Pull returns reference data plus diary changes after the cursor.
//
// Rows are only returned once they are older than a short settle window, so a
// transaction that took a lower change_seq but committed later is not skipped
// by a client whose cursor has already moved past it. Sync writes are single
// short statements, so a few seconds is ample.
func (s *Store) Pull(ctx context.Context, tenantID string, since int64, limit int) (PullResponse, error) {
	out := PullResponse{Projects: []ProjectRef{}, DiaryEntries: []DiaryEntry{}, Cursor: since}
	err := db.WithTenant(ctx, s.pool, tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `select id, code, name, status::text from projects order by code`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var pr ProjectRef
			if err := rows.Scan(&pr.ID, &pr.Code, &pr.Name, &pr.Status); err != nil {
				return err
			}
			out.Projects = append(out.Projects, pr)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		rows, err = tx.Query(ctx, `
			select `+diaryColumns+` from site_diary_entries
			where change_seq > $1 and updated_at < now() - interval '2 seconds'
			order by change_seq
			limit $2`, since, limit+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			e, err := scanDiary(rows)
			if err != nil {
				return err
			}
			out.DiaryEntries = append(out.DiaryEntries, e)
		}
		return rows.Err()
	})
	if err != nil {
		return out, err
	}
	if len(out.DiaryEntries) > limit {
		out.DiaryEntries, out.HasMore = out.DiaryEntries[:limit], true
	}
	if n := len(out.DiaryEntries); n > 0 {
		out.Cursor = out.DiaryEntries[n-1].ChangeSeq
	}
	return out, nil
}

func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }
