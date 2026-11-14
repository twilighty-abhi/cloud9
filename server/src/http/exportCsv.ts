// Session results → CSV. Agent B.
import type { AnswerRow, PlayerRow, SessionRow } from '../contracts';
import { csvRow } from '../util/csv';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Non-kicked players with per-question answers and totals, in final rank order (score, then faster correct answers, then join order). */
export function rankPlayers(session: SessionRow, players: PlayerRow[], answers: AnswerRow[]) {
  const questions = session.quiz.questions;
  const qPos = new Map<string, number>();
  questions.forEach((q, i) => qPos.set(q.id, i));

  const byPlayer = new Map<string, (AnswerRow | undefined)[]>();
  for (const a of answers) {
    const idx = qPos.get(a.questionId) ?? (a.qIndex >= 0 && a.qIndex < questions.length ? a.qIndex : -1);
    if (idx < 0) continue;
    let arr = byPlayer.get(a.playerId);
    if (!arr) { arr = new Array(questions.length); byPlayer.set(a.playerId, arr); }
    if (!arr[idx]) arr[idx] = a;
  }

  const rows = players
    .filter((p) => !p.kicked)
    .map((p) => {
      const ans = byPlayer.get(p.id) ?? new Array<AnswerRow | undefined>(questions.length);
      let correctCount = 0, answered = 0, totalMs = 0, correctMs = 0, pointsSum = 0;
      for (const a of ans) {
        if (!a) continue;
        answered++;
        totalMs += a.responseMs;
        pointsSum += a.points;
        if (a.correct) { correctCount++; correctMs += a.responseMs; }
      }
      // player.score is authoritative; fall back to the answer sum if the score was never persisted
      const score = p.score > 0 ? p.score : pointsSum;
      return { p, ans, score, correctCount, answered, totalMs, correctMs };
    });

  rows.sort((a, b) => b.score - a.score || a.correctMs - b.correctMs || a.p.joinedAt - b.p.joinedAt);
  return rows;
}

export function buildExportCsv(session: SessionRow, players: PlayerRow[], answers: AnswerRow[]): string {
  const questions = session.quiz.questions;
  const rows = rankPlayers(session, players, answers);

  const header = ['rank', 'name', 'email', 'score', 'correct_count', 'answered_count', 'total_response_ms'];
  questions.forEach((_, i) => header.push(`q${i + 1}_choice`, `q${i + 1}_correct`, `q${i + 1}_points`, `q${i + 1}_ms`));

  const lines = [csvRow(header)];
  rows.forEach((r, i) => {
    const cells: unknown[] = [i + 1, r.p.name, r.p.email ?? '', r.score, r.correctCount, r.answered, r.totalMs];
    for (let q = 0; q < questions.length; q++) {
      const a = r.ans[q];
      if (!a) cells.push('', '', '', '');
      else cells.push(LETTERS[a.choice] ?? String(a.choice), a.correct ? 1 : 0, a.points, a.responseMs);
    }
    lines.push(csvRow(cells));
  });
  // BOM so Excel opens UTF-8 names correctly
  return '﻿' + lines.join('\r\n') + '\r\n';
}
