/**
 * Drizzle table definitions — a typed mirror of migrations/*.sql.
 * The SQL migrations are the source of truth (they carry RLS policies, roles
 * and functions that Drizzle does not model); keep this file in sync with them.
 */
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const tenantTier = pgEnum('tenant_tier', ['standard', 'mid_market', 'enterprise']);

export const userRole = pgEnum('user_role', [
  'owner',
  'admin',
  'project_manager',
  'site_foreman',
  'finance',
  'viewer',
]);

export const projectStatus = pgEnum('project_status', [
  'tender',
  'awarded',
  'active',
  'practical_completion',
  'final_account',
  'closed',
]);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  tier: tenantTier('tier').notNull().default('standard'),
  activeModules: text('active_modules').array().notNull().default([]),
  ...timestamps,
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  email: text('email').notNull(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  status: projectStatus('status').notNull().default('tender'),
  contractForm: text('contract_form'),
  // numeric comes back as a string — never convert money to a JS float.
  contractValue: numeric('contract_value', { precision: 18, scale: 2 }),
  ...timestamps,
});

export const auditEvents = pgTable('audit_events', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
});

export const fileStatus = pgEnum('file_status', ['pending', 'uploaded', 'rejected']);

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id'),
  objectKey: text('object_key').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  category: text('category').notNull().default('general'),
  status: fileStatus('status').notNull().default('pending'),
  uploadedBy: uuid('uploaded_by').notNull(),
  ...timestamps,
});

export const weatherCondition = pgEnum('weather_condition', [
  'clear',
  'cloudy',
  'rain',
  'storm',
  'wind',
  'extreme_heat',
]);

export const siteDiaryEntries = pgTable('site_diary_entries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id').notNull(),
  entryDate: date('entry_date').notNull(),
  weather: weatherCondition('weather'),
  workforceCount: integer('workforce_count'),
  workCompleted: text('work_completed').notNull().default(''),
  delays: text('delays').notNull().default(''),
  safetyNotes: text('safety_notes').notNull().default(''),
  createdBy: uuid('created_by').notNull(),
  deviceId: text('device_id'),
  clientRecordedAt: timestamp('client_recorded_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  changeSeq: bigint('change_seq', { mode: 'number' }).notNull().default(0),
  ...timestamps,
});

export const aiJobStatus = pgEnum('ai_job_status', ['queued', 'running', 'succeeded', 'failed']);

export const aiJobs = pgTable('ai_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  status: aiJobStatus('status').notNull().default('queued'),
  projectId: uuid('project_id'),
  fileId: uuid('file_id'),
  requestedBy: uuid('requested_by').notNull(),
  model: text('model'),
  result: jsonb('result'),
  error: text('error'),
  ...timestamps,
});

export type Tenant = typeof tenants.$inferSelect;
export type SiteDiaryEntry = typeof siteDiaryEntries.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type FileRecord = typeof files.$inferSelect;
export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type UserRole = (typeof userRole.enumValues)[number];
