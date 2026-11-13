-- Cloud 9 schema. Applied idempotently at boot by db/repo.ts (Agent B).
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS moderators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_super INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS moderator_sessions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderator_sessions_expiry ON moderator_sessions(expires_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  moderator_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email_required INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY,
  moderator_id TEXT NOT NULL,
  title TEXT NOT NULL,
  email_mode TEXT NOT NULL CHECK (email_mode IN ('off','optional','required')),
  scoring TEXT NOT NULL DEFAULT 'speed' CHECK (scoring IN ('speed','flat')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  image_url TEXT,
  options_json TEXT NOT NULL,
  correct_index INTEGER NOT NULL,
  time_limit_sec INTEGER NOT NULL DEFAULT 20,
  points_max INTEGER NOT NULL DEFAULT 1000
);
CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id, position);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  quiz_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  listed INTEGER NOT NULL DEFAULT 1,
  join_open INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  current_q INTEGER NOT NULL DEFAULT -1,
  q_started_at INTEGER,
  q_ends_at INTEGER,
  quiz_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(code, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  token_hash TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  kicked INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_id, joined_at);

CREATE TABLE IF NOT EXISTS answers (
  session_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  q_index INTEGER NOT NULL,
  choice INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  response_ms INTEGER NOT NULL,
  points INTEGER NOT NULL,
  answered_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, player_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_session_q ON answers(session_id, question_id);

-- v2 (events). Existing production DBs: repo.ts MUST migrate idempotently at boot, checking PRAGMA table_info first:
--   ALTER TABLE quizzes  ADD COLUMN event_id TEXT;   CREATE INDEX IF NOT EXISTS idx_quizzes_event  ON quizzes(event_id);
--   ALTER TABLE sessions ADD COLUMN event_id TEXT;   CREATE INDEX IF NOT EXISTS idx_sessions_event ON sessions(event_id);
--   CREATE INDEX IF NOT EXISTS idx_players_email ON players(email);
