package syncapi

import (
	"strings"
	"testing"
)

func ptr[T any](v T) *T { return &v }

const (
	entryID   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	projectID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
)

func TestValidateAcceptsCreateAndUpdate(t *testing.T) {
	create := Mutation{ID: entryID, Op: "create", Entity: "site_diary_entry",
		Data: DiaryData{ProjectID: ptr(projectID), EntryDate: ptr("2026-11-09"), Weather: ptr("rain"), WorkforceCount: ptr(42)}}
	if err := create.Validate(); err != nil {
		t.Fatalf("create: %v", err)
	}
	update := Mutation{ID: entryID, Op: "update", Entity: "site_diary_entry", BaseVersion: ptr(1),
		Data: DiaryData{Delays: ptr("Rain stopped work 2h")}}
	if err := update.Validate(); err != nil {
		t.Fatalf("update: %v", err)
	}
}

func TestValidateRejects(t *testing.T) {
	base := func() Mutation {
		return Mutation{ID: entryID, Op: "create", Entity: "site_diary_entry",
			Data: DiaryData{ProjectID: ptr(projectID), EntryDate: ptr("2026-11-09")}}
	}
	cases := map[string]func(m *Mutation){
		"bad id":             func(m *Mutation) { m.ID = "1; drop table x" },
		"bad op":             func(m *Mutation) { m.Op = "delete" },
		"bad entity":         func(m *Mutation) { m.Entity = "users" },
		"no project":         func(m *Mutation) { m.Data.ProjectID = nil },
		"no date":            func(m *Mutation) { m.Data.EntryDate = nil },
		"bad date":           func(m *Mutation) { m.Data.EntryDate = ptr("09/11/2026") },
		"bad weather":        func(m *Mutation) { m.Data.Weather = ptr("snowpocalypse") },
		"negative workforce": func(m *Mutation) { m.Data.WorkforceCount = ptr(-1) },
		"huge text":          func(m *Mutation) { m.Data.WorkCompleted = ptr(strings.Repeat("x", MaxTextLen+1)) },
		"update w/o version": func(m *Mutation) { m.Op = "update"; m.Data.ProjectID = nil },
		"update moves project": func(m *Mutation) {
			m.Op = "update"
			m.BaseVersion = ptr(1)
		},
	}
	for name, mutate := range cases {
		m := base()
		mutate(&m)
		if err := m.Validate(); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
}
