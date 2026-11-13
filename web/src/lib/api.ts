// Typed fetch helpers. Owned by lead.
import type { ApiError } from '../../../shared/api';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const e = (data && typeof data === 'object' ? data : {}) as Partial<ApiError>;
    throw new HttpError(res.status, e.error ?? 'http_error', e.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const get = <T>(url: string) => api<T>('GET', url);
export const post = <T>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const put = <T>(url: string, body: unknown) => api<T>('PUT', url, body);
export const patch = <T>(url: string, body: unknown) => api<T>('PATCH', url, body);
export const del = <T>(url: string) => api<T>('DELETE', url);
