/**
 * Drizzle table definitions — a typed mirror of migrations/*.sql.
 * The SQL migrations are the source of truth (they carry RLS policies, roles
 * and functions that Drizzle does not model); keep this file in sync with them.
 */
import {
  boolean,
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

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type UserRole = (typeof userRole.enumValues)[number];
