// Telegram HTML parse-mode helpers. Owned by lead.
export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const b = (s: unknown) => `<b>${esc(s)}</b>`;
export const i = (s: unknown) => `<i>${esc(s)}</i>`;
export const code = (s: unknown) => `<code>${esc(s)}</code>`;
/** "mod_hall1" → "hall1" */
export const modName = (moderatorId: string) => (moderatorId.startsWith('telegram:') ? 'admin (via Telegram)' : moderatorId.replace(/^mod_/, ''));
export const fmtCode = (c: string) => (c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c);
export const medal = (rank: number) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`);
/** Truncate HTML-safe text to n chars without cutting inside an entity/tag (simple: cut at last newline before n). */
export function clip(s: string, n = 4000): string {
  if (s.length <= n) return s;
  const cut = s.lastIndexOf('\n', n - 2);
  return s.slice(0, cut > 0 ? cut : n - 2) + '\n…';
}
