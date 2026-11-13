// Cloud 9 — SQLite repository (better-sqlite3, synchronous). Agent B.
import Database from 'better-sqlite3';
import type { QuizDef, QuizListItem, QuestionDef, RoomState } from '../../../shared/model';
import type { Repo, SessionRow, PlayerRow, AnswerRow, ModeratorRow } from '../contracts';
import { SCHEMA_SQL } from './schema';

const FLUSH_INTERVAL_MS = 100;
const MAX_QUEUE = 50_000; // hard cap so a stuck DB can never OOM the process

type Row = Record<string, any>;

const b2i = (b: boolean) => (b ? 1 : 0);

function rowToSession(r: Row): SessionRow {
  return {
    id: r.id,
    code: r.code,
    quizId: r.quiz_id,
    moderatorId: r.moderator_id,
    label: r.label,
    listed: !!r.listed,
    joinOpen: !!r.join_open,
    state: r.state as RoomState,
    qIndex: r.current_q,
    qStartedAt: r.q_started_at ?? null,
    qEndsAt: r.q_ends_at ?? null,
    quiz: JSON.parse(r.quiz_json) as QuizDef,
    createdAt: r.created_at,
    endedAt: r.ended_at ?? null,
  };
}

function rowToPlayer(r: Row): PlayerRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    name: r.name,
    email: r.email ?? null,
    tokenHash: r.token_hash,
    score: r.score,
    kicked: !!r.kicked,
    joinedAt: r.joined_at,
  };
}

function rowToAnswer(r: Row): AnswerRow {
  return {
    sessionId: r.session_id,
    playerId: r.player_id,
    questionId: r.question_id,
    qIndex: r.q_index,
    choice: r.choice,
    correct: !!r.correct,
    responseMs: r.response_ms,
    points: r.points,
    answeredAt: r.answered_at,
  };
}

// SessionRow field → column (whitelist for dynamic UPDATE)
const SESSION_COLS: Record<string, string> = {
  code: 'code',
  quizId: 'quiz_id',
  moderatorId: 'moderator_id',
  label: 'label',
  listed: 'listed',
  joinOpen: 'join_open',
  state: 'state',
  qIndex: 'current_q',
  qStartedAt: 'q_started_at',
  qEndsAt: 'q_ends_at',
  createdAt: 'created_at',
  endedAt: 'ended_at',
};
const PLAYER_COLS: Record<string, string> = { score: 'score', kicked: 'kicked', name: 'name' };

function toDb(v: unknown): unknown {
  if (typeof v === 'boolean') return b2i(v);
  if (v === undefined) return null;
  return v;
}

export function openRepo(dbPath: string): Repo {
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);

  const st = {
    upsertMod: db.prepare(
      `INSERT INTO moderators (id, username, display_name, is_super, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, is_super = excluded.is_super`,
    ),
    deleteModByUsername: db.prepare(`DELETE FROM moderators WHERE username = ? AND id <> ?`),
    listQuizzesAll: db.prepare(
      `SELECT q.id, q.moderator_id, q.title, q.updated_at, (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS n
       FROM quizzes q ORDER BY q.updated_at DESC`,
    ),
    listQuizzesMod: db.prepare(
      `SELECT q.id, q.moderator_id, q.title, q.updated_at, (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS n
       FROM quizzes q WHERE q.moderator_id = ? ORDER BY q.updated_at DESC`,
    ),
    getQuiz: db.prepare(`SELECT * FROM quizzes WHERE id = ?`),
    getQuestions: db.prepare(`SELECT * FROM questions WHERE quiz_id = ? ORDER BY position`),
    upsertQuiz: db.prepare(
      `INSERT INTO quizzes (id, moderator_id, title, email_mode, scoring, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET moderator_id = excluded.moderator_id, title = excluded.title, email_mode = excluded.email_mode,
         scoring = excluded.scoring, updated_at = excluded.updated_at`,
    ),
    deleteQuestions: db.prepare(`DELETE FROM questions WHERE quiz_id = ?`),
    insertQuestion: db.prepare(
      `INSERT INTO questions (id, quiz_id, position, text, image_url, options_json, correct_index, time_limit_sec, points_max)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    deleteQuiz: db.prepare(`DELETE FROM quizzes WHERE id = ?`),
    insertSession: db.prepare(
      `INSERT INTO sessions (id, code, quiz_id, moderator_id, label, listed, join_open, state, current_q, q_started_at, q_ends_at, quiz_json, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listSessionsAll: db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 100`),
    listSessionsMod: db.prepare(`SELECT * FROM sessions WHERE moderator_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`),
    unfinished: db.prepare(`SELECT * FROM sessions WHERE state <> 'FINISHED' ORDER BY created_at`),
    latestByCode: db.prepare(`SELECT * FROM sessions WHERE code = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`),
    insertPlayer: db.prepare(
      `INSERT OR IGNORE INTO players (id, session_id, name, email, token_hash, score, kicked, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listPlayers: db.prepare(`SELECT * FROM players WHERE session_id = ? ORDER BY joined_at, rowid`),
    countPlayers: db.prepare(`SELECT COUNT(*) AS n FROM players WHERE session_id = ? AND kicked = 0`),
    insertAnswer: db.prepare(
      `INSERT OR IGNORE INTO answers (session_id, player_id, question_id, q_index, choice, correct, response_ms, points, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listAnswers: db.prepare(`SELECT * FROM answers WHERE session_id = ? ORDER BY q_index, answered_at`),
  };

  const updateCache = new Map<string, Database.Statement>();
  function dynUpdate(table: string, cols: Record<string, string>, id: string, patch: Record<string, unknown>) {
    const keys = Object.keys(patch).filter((k) => k in cols && (patch as any)[k] !== undefined).sort();
    if (keys.length === 0) return;
    const sig = `${table}:${keys.join(',')}`;
    let stmt = updateCache.get(sig);
    if (!stmt) {
      stmt = db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`);
      updateCache.set(sig, stmt);
    }
    stmt.run(...keys.map((k) => toDb(patch[k])), id);
  }

  const saveQuizTx = db.transaction((q: QuizDef) => {
    st.upsertQuiz.run(q.id, q.moderatorId, q.title, q.emailMode, q.scoring, q.createdAt, q.updatedAt);
    st.deleteQuestions.run(q.id);
    q.questions.forEach((qq, i) => {
      st.insertQuestion.run(qq.id, q.id, i, qq.text, qq.imageUrl ?? null, JSON.stringify(qq.options), qq.correctIndex, qq.timeLimitSec, qq.pointsMax);
    });
  });

  // ── answer queue ──
  let queue: AnswerRow[] = [];
  let closed = false;
  const flushTx = db.transaction((rows: AnswerRow[]) => {
    for (const a of rows) {
      st.insertAnswer.run(a.sessionId, a.playerId, a.questionId, a.qIndex, a.choice, b2i(a.correct), Math.round(a.responseMs), Math.round(a.points), a.answeredAt);
    }
  });
  function flush(): void {
    if (queue.length === 0 || closed) return;
    const rows = queue;
    queue = [];
    try {
      flushTx(rows);
    } catch (e) {
      // keep the rows for the next attempt (bounded), never crash the timer
      console.error('[repo] answer flush failed:', (e as Error).message);
      if (queue.length + rows.length <= MAX_QUEUE) queue = rows.concat(queue);
    }
  }
  const timer = setInterval(flush, FLUSH_INTERVAL_MS);
  timer.unref();

  return {
    upsertModerator(m: ModeratorRow) {
      db.transaction(() => {
        // a username could previously belong to a different id → free it so UNIQUE(username) doesn't throw
        st.deleteModByUsername.run(m.username, m.id);
        st.upsertMod.run(m.id, m.username, m.displayName, b2i(m.isSuper), Date.now());
      })();
    },

    listQuizzes(moderatorId) {
      const rows = (moderatorId === null ? st.listQuizzesAll.all() : st.listQuizzesMod.all(moderatorId)) as Row[];
      return rows.map((r): QuizListItem => ({ id: r.id, moderatorId: r.moderator_id, title: r.title, questionCount: r.n, updatedAt: r.updated_at }));
    },

    getQuiz(id) {
      const q = st.getQuiz.get(id) as Row | undefined;
      if (!q) return null;
      const questions = (st.getQuestions.all(id) as Row[]).map(
        (r): QuestionDef => ({
          id: r.id,
          text: r.text,
          imageUrl: r.image_url ?? null,
          options: JSON.parse(r.options_json),
          correctIndex: r.correct_index,
          timeLimitSec: r.time_limit_sec,
          pointsMax: r.points_max,
        }),
      );
      return {
        id: q.id,
        moderatorId: q.moderator_id,
        title: q.title,
        emailMode: q.email_mode,
        scoring: q.scoring,
        questions,
        createdAt: q.created_at,
        updatedAt: q.updated_at,
      };
    },

    saveQuiz(q) {
      saveQuizTx(q);
    },

    deleteQuiz(id) {
      st.deleteQuiz.run(id); // questions cascade
    },

    insertSession(s) {
      st.insertSession.run(
        s.id, s.code, s.quizId, s.moderatorId, s.label, b2i(s.listed), b2i(s.joinOpen), s.state, s.qIndex,
        s.qStartedAt ?? null, s.qEndsAt ?? null, JSON.stringify(s.quiz), s.createdAt, s.endedAt ?? null,
      );
    },

    updateSession(id, patch) {
      dynUpdate('sessions', SESSION_COLS, id, patch as Record<string, unknown>);
    },

    listSessions(moderatorId) {
      const rows = (moderatorId === null ? st.listSessionsAll.all() : st.listSessionsMod.all(moderatorId)) as Row[];
      return rows.map(rowToSession);
    },

    loadUnfinishedSessions() {
      return (st.unfinished.all() as Row[]).map(rowToSession);
    },

    getLatestSessionByCode(code) {
      const r = st.latestByCode.get(code) as Row | undefined;
      return r ? rowToSession(r) : null;
    },

    insertPlayer(p) {
      st.insertPlayer.run(p.id, p.sessionId, p.name, p.email ?? null, p.tokenHash, p.score, b2i(p.kicked), p.joinedAt);
    },

    updatePlayer(id, patch) {
      dynUpdate('players', PLAYER_COLS, id, patch as Record<string, unknown>);
    },

    listPlayers(sessionId) {
      return (st.listPlayers.all(sessionId) as Row[]).map(rowToPlayer);
    },

    countPlayers(sessionId) {
      return (st.countPlayers.get(sessionId) as Row).n as number;
    },

    queueAnswer(a) {
      if (closed) return;
      if (queue.length >= MAX_QUEUE) flush();
      if (queue.length >= MAX_QUEUE) return; // DB is broken; drop rather than OOM
      queue.push(a);
    },

    listAnswers(sessionId) {
      flush();
      return (st.listAnswers.all(sessionId) as Row[]).map(rowToAnswer);
    },

    flush,

    close() {
      if (closed) return;
      clearInterval(timer);
      flush();
      closed = true;
      try { db.close(); } catch { /* ignore */ }
    },
  };
}
