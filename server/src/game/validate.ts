// Cloud 9 — player input validation (name / email) and display-name dedupe. Pure functions.
import { DEFAULTS, type EmailMode } from '../../../shared/model';

// Control chars (C0, DEL, C1) plus zero-width / bidi formatting chars that can be abused in display names.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns the cleaned name, or null if invalid (empty / too long / not a string). */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > 500) return null;
  const s = raw.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  const len = [...s].length;
  if (len < 1 || len > DEFAULTS.nameMax) return null;
  return s;
}

export type EmailCheck = { ok: true; email: string | null } | { ok: false; error: 'email_required' | 'invalid_email' };

export function checkEmail(raw: unknown, mode: EmailMode): EmailCheck {
  if (mode === 'off') return { ok: true, email: null };
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!s) return mode === 'required' ? { ok: false, error: 'email_required' } : { ok: true, email: null };
  if (s.length > DEFAULTS.emailMax || !EMAIL_RE.test(s)) return { ok: false, error: 'invalid_email' };
  return { ok: true, email: s };
}

/** Case-insensitive dedupe: "Anu" → "Anu (2)" → "Anu (3)". `taken` holds lowercase names. Result stays ≤ nameMax chars. */
export function dedupeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100000; n++) {
    const candidate = withSuffix(name, n);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name; // unreachable in practice
}

/** "Anu" + 2 → "Anu (2)", truncating the base so the result stays ≤ nameMax chars (same rule dedupeName uses). */
function withSuffix(name: string, n: number): string {
  const suffix = ` (${n})`;
  const chars = [...name];
  const base = chars.length + suffix.length > DEFAULTS.nameMax ? chars.slice(0, DEFAULTS.nameMax - suffix.length).join('').trimEnd() : name;
  return base + suffix;
}

/**
 * True if `submitted` (a cleaned name) is the name that produced the existing display name, case-insensitively,
 * ignoring the " (N)" dedupe suffix: "anu" matches "Anu" and "Anu (2)". Used to allow an email rebind.
 */
export function sameDisplayName(submitted: string, existing: string): boolean {
  const s = submitted.toLowerCase();
  const e = existing.toLowerCase();
  if (s === e) return true;
  const m = / \((\d+)\)$/.exec(e);
  if (!m) return false;
  return withSuffix(s, Number(m[1])) === e;
}
