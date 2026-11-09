export type ModuleId =
  | 'mod_field'
  | 'mod_finance'
  | 'mod_payroll'
  | 'mod_procurement'
  | 'mod_hse'
  | 'mod_ai';

export interface Me {
  user: { id: string; email: string; fullName: string; role: string };
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const token = session.token;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`/api/v1${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

export const api = {
  login: (tenant: string, email: string, password: string) =>
    request<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ tenant, email, password }),
    }),
  me: () => request<Me>('/me'),
  projects: () => request<Project[]>('/projects'),
};
