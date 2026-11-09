export type ModuleId =
  | 'mod_commercial'
  | 'mod_payroll'
  | 'mod_crm'
  | 'mod_finance'
  | 'mod_estimating'
  | 'mod_procurement'
  | 'mod_field'
  | 'mod_fleet'
  | 'mod_hse'
  | 'mod_portal'
  | 'mod_ai';

export type Role = 'owner' | 'admin' | 'project_manager' | 'site_foreman' | 'finance' | 'viewer';

export interface Me {
  user: { id: string; email: string; fullName: string; role: Role };
  tenant: { id: string; slug: string; name: string; tier: string };
  modules: ModuleId[];
}

export interface Project {
  id: string;
  code: string;
  name: string;
  status: string;
  contractForm: string | null;
  contractValue: string | null;
  createdAt: string;
}

export interface DiaryEntry {
  id: string;
  entryDate: string;
  weather: string | null;
  workforceCount: number | null;
  workCompleted: string;
  delays: string;
  safetyNotes: string;
  deviceId: string | null;
  version: number;
  createdAt: string;
}

export interface FileRecord {
  id: string;
  projectId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  category: string;
  status: string;
  createdAt: string;
}

export interface AuditEvent {
  seq: number;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  payload: Record<string, unknown>;
}

export interface ChainVerification {
  intact: boolean;
  eventsChecked: number;
  firstBrokenSeq: number | null;
  headHash: string;
  verifiedAt: string;
}

export interface BoqResult {
  document_title: string | null;
  currency: string;
  sections: {
    name: string;
    items: { item_no: string; description: string; unit: string; quantity: string | null; rate: string | null; amount: string | null }[];
  }[];
  warnings: string[];
}

export interface DiaryReviewResult {
  summary: string;
  risks: { category: string; severity: 'low' | 'medium' | 'high'; finding: string; evidence_dates: string[]; recommendation: string }[];
}

export interface AiJob {
  id: string;
  kind: 'boq_extraction' | 'diary_risk_review';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  projectId: string | null;
  fileId: string | null;
  model: string | null;
  result: BoqResult | DiaryReviewResult | null;
  error: string | null;
  createdAt: string;
}

export type EstimateStage = 'intake' | 'technical_review' | 'client_approval' | 'baseline_locked' | 'rejected';
export type LineFlag = 'missing_internal' | 'missing_client' | 'qty_mismatch' | 'rate_variance' | 'under_recovery';

export interface EstimateSummary {
  clientTotal: string;
  internalTotal: string;
  margin: string;
  marginPct: string | null;
  leakage: string;
  lines: number;
  flaggedLines: number;
  flagCounts: Record<LineFlag, number>;
}

export interface EstimateLine {
  id: string;
  lineNo: string;
  description: string;
  unit: string;
  source: string;
  clientQty: string | null;
  clientRate: string | null;
  clientAmount: string | null;
  internalQty: string | null;
  internalRate: string | null;
  internalAmount: string | null;
  margin: string | null;
  flags: LineFlag[];
}

export interface EstimateHeader {
  id: string;
  ref: string;
  title: string;
  clientName: string;
  clientReference: string | null;
  stage: EstimateStage;
  projectId: string | null;
  clientApprovalRef: string | null;
  rejectionReason: string | null;
  baselineClientTotal: string | null;
  baselineInternalTotal: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summary: EstimateSummary;
}

export interface Estimate extends EstimateHeader {
  lines: EstimateLine[];
}

export interface LineInput {
  lineNo: string;
  description: string;
  unit: string;
  clientQty?: string | null;
  clientRate?: string | null;
  internalQty?: string | null;
  internalRate?: string | null;
}

export interface OrgUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  status: 'active' | 'invited' | 'deactivated';
  inviteExpiresAt: string | null;
  createdAt: string;
}

export interface InviteLink {
  inviteUrl: string;
  expiresAt: string;
  purpose?: 'invite' | 'reset';
}

export interface InviteInfo {
  purpose: 'invite' | 'reset';
  email: string;
  fullName: string;
  organisation: { name: string; id: string };
  expiresAt: string;
}

export interface FormulaResult {
  ok: boolean;
  variables?: string[];
  result?: string | boolean;
  error?: string;
  position?: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'constructos.token';

export const session = {
  get token(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
  },
};

/** Calls any of the three services; paths start with /api, /sync or /ai. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const token = session.token;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string | string[]; detail?: unknown };
    const detail = typeof body.detail === 'string' ? body.detail : Array.isArray(body.detail) ? 'Invalid request' : undefined;
    const message = Array.isArray(body.message) ? body.message.join(', ') : body.message ?? detail ?? res.statusText;
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  login: (tenant: string, email: string, password: string) =>
    post<{ accessToken: string }>('/api/v1/auth/login', { tenant, email, password }),
  me: () => request<Me>('/api/v1/me'),

  users: () => request<OrgUser[]>('/api/v1/users'),
  inviteUser: (body: { email: string; fullName: string; role: Role }) =>
    post<InviteLink & { user: Pick<OrgUser, 'id' | 'email' | 'fullName' | 'role'> }>('/api/v1/users/invite', body),
  userLink: (id: string) => post<InviteLink>(`/api/v1/users/${id}/link`, {}),
  updateUser: (id: string, body: { role?: Role; isActive?: boolean }) =>
    request<Pick<OrgUser, 'id' | 'role' | 'isActive'>>(`/api/v1/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  inviteInfo: (token: string) => request<InviteInfo>(`/api/v1/auth/invite/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string) =>
    post<{ accessToken: string; organisation: { id: string; name: string } }>('/api/v1/auth/invite/accept', { token, password }),

  projects: () => request<Project[]>('/api/v1/projects'),
  createProject: (body: { code: string; name: string; contractForm?: string; contractValue?: string }) =>
    post<Project>('/api/v1/projects', body),

  diary: (projectId: string) => request<DiaryEntry[]>(`/api/v1/projects/${projectId}/diary`),
  createDiary: (projectId: string, body: Partial<DiaryEntry> & { id: string; entryDate: string }) =>
    post<DiaryEntry>(`/api/v1/projects/${projectId}/diary`, body),

  files: (projectId?: string) => request<FileRecord[]>(`/api/v1/files${projectId ? `?projectId=${projectId}` : ''}`),
  async uploadFile(file: File, category: string, projectId?: string): Promise<FileRecord> {
    const contentType = file.type || 'application/octet-stream';
    const slot = await post<{ fileId: string; uploadUrl: string; headers: Record<string, string> }>(
      '/api/v1/files/uploads',
      { filename: file.name, contentType, sizeBytes: file.size, category, projectId },
    );
    // Straight to S3 with the presigned URL; the bytes never pass through the API.
    const put = await fetch(slot.uploadUrl, { method: 'PUT', headers: slot.headers, body: file });
    if (!put.ok) throw new ApiError(put.status, 'Upload to storage failed');
    return post<FileRecord>(`/api/v1/files/${slot.fileId}/complete`, {});
  },
  downloadUrl: (fileId: string) => request<{ url: string }>(`/api/v1/files/${fileId}/download`),

  auditEvents: (beforeSeq?: number) =>
    request<AuditEvent[]>(`/api/v1/audit/events?limit=50${beforeSeq ? `&beforeSeq=${beforeSeq}` : ''}`),
  verifyAudit: () => request<ChainVerification>('/api/v1/audit/verify'),

  evaluateFormula: (formula: string, variables: Record<string, string | boolean>) =>
    post<FormulaResult>('/api/v1/formulas/evaluate', { formula, variables }),

  estimates: () => request<EstimateHeader[]>('/api/v1/estimates'),
  estimate: (id: string) => request<Estimate>(`/api/v1/estimates/${id}`),
  createEstimate: (body: { ref: string; title: string; clientName: string; clientReference?: string }) =>
    post<Estimate>('/api/v1/estimates', body),
  addLine: (id: string, body: LineInput) => post<Estimate>(`/api/v1/estimates/${id}/lines`, body),
  updateLine: (id: string, lineId: string, body: Partial<LineInput>) =>
    request<Estimate>(`/api/v1/estimates/${id}/lines/${lineId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteLine: (id: string, lineId: string) => request<Estimate>(`/api/v1/estimates/${id}/lines/${lineId}`, { method: 'DELETE' }),
  importAiLines: (id: string, jobId: string) => post<Estimate>(`/api/v1/estimates/${id}/import-ai`, { jobId }),
  transitionEstimate: (
    id: string,
    body: { to: EstimateStage; note?: string; clientApprovalRef?: string; acknowledgeVariance?: boolean },
  ) => post<Estimate>(`/api/v1/estimates/${id}/transition`, body),
  entityHistory: (entityType: string, entityId: string) =>
    request<AuditEvent[]>(`/api/v1/audit/events?entityType=${entityType}&entityId=${entityId}&limit=50`),

  aiJobs: () => request<AiJob[]>('/ai/v1/jobs'),
  aiJob: (id: string) => request<AiJob>(`/ai/v1/jobs/${id}`),
  createAiJob: (body: { kind: AiJob['kind']; fileId?: string; projectId?: string }) => post<AiJob>('/ai/v1/jobs', body),
};

export const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });
/** Display only. Never use for arithmetic. */
export const formatZar = (v: string | null | undefined) => (v ? zar.format(Number(v)) : '—');
export const label = (s: string) => s.replace(/_/g, ' ');
