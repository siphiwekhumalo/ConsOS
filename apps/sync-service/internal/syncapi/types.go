package syncapi

import (
	"fmt"
	"time"

	"github.com/constructos/sync-service/internal/db"
)

const (
	MaxMutationsPerPush = 500
	MaxBodyBytes        = 5 << 20 // 5 MB
	MaxTextLen          = 20000
	DefaultPullLimit    = 500
	MaxPullLimit        = 2000
)

// PushRequest is a batch of offline changes from one device.
type PushRequest struct {
	DeviceID  string     `json:"deviceId"`
	Mutations []Mutation `json:"mutations"`
}

// Mutation is one client change. For "create", ID is the new row's
// client-generated UUID, which makes retries idempotent.
type Mutation struct {
	ID          string    `json:"id"`
	Op          string    `json:"op"`     // "create" | "update"
	Entity      string    `json:"entity"` // "site_diary_entry"
	BaseVersion *int      `json:"baseVersion,omitempty"`
	Data        DiaryData `json:"data"`
}

type DiaryData struct {
	ProjectID        *string    `json:"projectId,omitempty"`
	EntryDate        *string    `json:"entryDate,omitempty"`
	Weather          *string    `json:"weather,omitempty"`
	WorkforceCount   *int       `json:"workforceCount,omitempty"`
	WorkCompleted    *string    `json:"workCompleted,omitempty"`
	Delays           *string    `json:"delays,omitempty"`
	SafetyNotes      *string    `json:"safetyNotes,omitempty"`
	ClientRecordedAt *time.Time `json:"clientRecordedAt,omitempty"`
}

// MutationResult statuses.
const (
	StatusApplied   = "applied"
	StatusDuplicate = "duplicate" // already applied earlier (safe retry)
	StatusConflict  = "conflict"  // baseVersion is stale; server copy returned
	StatusRejected  = "rejected"  // invalid; will never succeed as sent
)

type MutationResult struct {
	ID           string      `json:"id"`
	Status       string      `json:"status"`
	Version      int         `json:"version,omitempty"`
	Error        string      `json:"error,omitempty"`
	ServerRecord *DiaryEntry `json:"serverRecord,omitempty"`
}

type PushResponse struct {
	Results []MutationResult `json:"results"`
	Summary map[string]int   `json:"summary"`
}

type DiaryEntry struct {
	ID               string     `json:"id"`
	ProjectID        string     `json:"projectId"`
	EntryDate        string     `json:"entryDate"`
	Weather          *string    `json:"weather"`
	WorkforceCount   *int32     `json:"workforceCount"`
	WorkCompleted    string     `json:"workCompleted"`
	Delays           string     `json:"delays"`
	SafetyNotes      string     `json:"safetyNotes"`
	CreatedBy        string     `json:"createdBy"`
	DeviceID         *string    `json:"deviceId"`
	ClientRecordedAt *time.Time `json:"clientRecordedAt"`
	Version          int32      `json:"version"`
	ChangeSeq        int64      `json:"changeSeq"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
}

type ProjectRef struct {
	ID     string `json:"id"`
	Code   string `json:"code"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type PullResponse struct {
	Projects     []ProjectRef `json:"projects"`
	DiaryEntries []DiaryEntry `json:"diaryEntries"`
	Cursor       int64        `json:"cursor"`
	HasMore      bool         `json:"hasMore"`
}

var weathers = map[string]bool{
	"clear": true, "cloudy": true, "rain": true, "storm": true, "wind": true, "extreme_heat": true,
}

// Validate checks a mutation without touching the database.
func (m *Mutation) Validate() error {
	if !db.IsUUID(m.ID) {
		return fmt.Errorf("id must be a UUID")
	}
	if m.Entity != "site_diary_entry" {
		return fmt.Errorf("unsupported entity %q", m.Entity)
	}
	d := m.Data
	switch m.Op {
	case "create":
		if d.ProjectID == nil || !db.IsUUID(*d.ProjectID) {
			return fmt.Errorf("create requires projectId (UUID)")
		}
		if d.EntryDate == nil {
			return fmt.Errorf("create requires entryDate")
		}
	case "update":
		if m.BaseVersion == nil || *m.BaseVersion < 1 {
			return fmt.Errorf("update requires baseVersion")
		}
		if d.ProjectID != nil {
			return fmt.Errorf("projectId cannot be changed")
		}
	default:
		return fmt.Errorf("op must be create or update")
	}
	if d.EntryDate != nil {
		if _, err := time.Parse("2006-01-02", *d.EntryDate); err != nil {
			return fmt.Errorf("entryDate must be YYYY-MM-DD")
		}
	}
	if d.Weather != nil && !weathers[*d.Weather] {
		return fmt.Errorf("unknown weather %q", *d.Weather)
	}
	if d.WorkforceCount != nil && (*d.WorkforceCount < 0 || *d.WorkforceCount > 100000) {
		return fmt.Errorf("workforceCount out of range")
	}
	for name, s := range map[string]*string{"workCompleted": d.WorkCompleted, "delays": d.Delays, "safetyNotes": d.SafetyNotes} {
		if s != nil && len(*s) > MaxTextLen {
			return fmt.Errorf("%s exceeds %d characters", name, MaxTextLen)
		}
	}
	return nil
}
