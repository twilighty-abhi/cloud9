// Player identity per room, kept in localStorage (wrapped: storage can throw/be empty). Owned by lead.
export interface StoredPlayer { playerId: string; token: string; name: string; joinedAt: number }
const key = (code: string) => `c9:player:${code}`;

export function getPlayer(code: string): StoredPlayer | null {
  try { const raw = localStorage.getItem(key(code)); return raw ? (JSON.parse(raw) as StoredPlayer) : null; } catch { return null; }
}
export function setPlayer(code: string, p: StoredPlayer) {
  try { localStorage.setItem(key(code), JSON.stringify(p)); } catch { /* ignore */ }
}
export function clearPlayer(code: string) {
  try { localStorage.removeItem(key(code)); } catch { /* ignore */ }
}
export function getLastName(): string {
  try { return localStorage.getItem('c9:lastName') ?? ''; } catch { return ''; }
}
export function setLastName(n: string) {
  try { localStorage.setItem('c9:lastName', n); } catch { /* ignore */ }
}
export function getLastEmail(): string {
  try { return localStorage.getItem('c9:lastEmail') ?? ''; } catch { return ''; }
}
export function setLastEmail(e: string) {
  try { localStorage.setItem('c9:lastEmail', e); } catch { /* ignore */ }
}
