# Cloud 9 — Master Plan & Technical Build Plan

> Lightweight live quiz platform for a single event with multiple moderators running multiple rooms at once.
> **Deadline:** build tonight (Fri 13 Nov 2026), production use tomorrow (Sat 14 Nov 2026).
> **Status:** Plan v1.2. Adds a public home page listing active sessions with one-tap Join (v1.1) and a parallel subagent build plan (§19a, v1.2). The defaults below are assumed until changed.

---

## 1. Goals & constraints

| Item | Target |
|---|---|
| Concurrent players | Design for **200+**, expect 100–120 |
| Rooms | Many at once, one moderator per room |
| Server | Hetzner, 4 GB RAM / 2 vCPU, ~1 GB already used by other workloads |
| Budget for Cloud 9 | Limit 2 GB RAM / 2 CPUs (measured: ~130 MB, ~3% CPU at 250 players) |
| Deploy | `docker compose up -d`, single command |
| UI | Minimal, Yuyu Design System look |
| Participant friction | Scan QR → type name → play. No signup |

**Non-goals for v1:** user accounts for players, question banks/marketplace, analytics dashboards, theming per quiz, multi-server scaling.

---

## 2. Product scope (v1)

### Moderator (admin)
- Log in with own moderator account
- Create a quiz: in-app editor **or** CSV/JSON import
- Start a session → room with **6-digit code + big QR + join link**
- Give each session a **label** (e.g. "Hall A · Round 1") and a **"Show on home page"** toggle (on by default). Hidden sessions can still be joined by QR or code.
- **Open / close joining** toggle per session (for example, close it once the quiz starts if late joiners aren't wanted)
- Lobby: live player list and count, kick a player
- Controls: **Start → Next question → Reveal → Leaderboard → … → End**
- Live answer counter while a question is open; question auto-closes when everyone has answered or the timer ends
- Per-question answer distribution and top 10 leaderboard
- Final podium and **CSV export** (name, email, score, per-question answers, response times)
- Dashboard shows only that moderator's rooms; super-admin sees all

### Home page (public, `/`)
- Opening the website shows **all active sessions** that moderators have marked "Show on home page"
- Each session card shows: quiz title, label, status (**Waiting to start** / **In progress · Q3 of 10**), player count, and a **Join** button
- Join is disabled with "Joining closed" when the moderator has closed joining; finished sessions drop off the list
- "Have a code?" box at the top for hidden sessions
- The list refreshes itself every 5 s, so no reload is needed
- If this browser already joined a session (token saved), its card shows **Rejoin** and skips the name step
- Empty state: "No quizzes are live right now. Hang tight."

Participants therefore have three ways in: **tap Join on the home page**, scan the QR, or type the code.

### Participant
- Tap Join on the home page / open join link / scan QR (code pre-filled) → enter **name** (+ optional **email**)
- Lobby "You're in" screen
- Question screen: question text, 2–4 big option buttons, countdown
- After answering: "Locked in" → on reveal, correct/incorrect + points earned + current rank
- Final screen: final rank and score
- Survives refresh, network drops and screen lock (auto-rejoin)

### Present mode (projector, optional)
- `/present/:code` read-only big-screen view: QR in lobby, question + timer, answer distribution, leaderboard. Moderator controls stay on their laptop/phone.

---

## 3. Defaults assumed (open to change)

| # | Question | Default |
|---|---|---|
| 1 | Question types | Single-choice, 2–4 options, optional image URL |
| 2 | Scoring | Speed-based: up to 1000 pts, min 500 for correct |
| 3 | Join info | Name required, email optional (toggle per quiz: off / optional / required) |
| 4 | Question on phones | Yes, full question text on phones too |
| 5 | Question entry | CSV import + simple in-app editor |
| 6 | Moderators | Individual accounts defined in env; one super-admin |
| 7 | Database | SQLite (WAL) — see §6 |
| 8 | Hosting/TLS | Caddy included in compose; can be dropped if a proxy already exists |

---

## 4. Architecture

```
                    ┌────────────────────────── Hetzner VPS ──────────────────────────┐
 Phones (200) ─┐    │                                                                 │
 Moderators ───┼──► │  Caddy (TLS, gzip, HTTP/2)  ──►  cloud9 (Node 22, 1 process)    │
 Projector ────┘    │        :443                       ├─ Fastify: HTTP API + static │
                    │                                   ├─ ws: realtime (/ws)         │
                    │                                   ├─ Room engine (in-memory)    │
                    │                                   └─ Persistence → SQLite (WAL) │
                    │                                          volume: ./data         │
                    └─────────────────────────────────────────────────────────────────┘
```

**Principles**
- **Server-authoritative.** The server owns room state, timers and scoring. Clients only render state and send intents.
- **In-memory hot path, durable cold path.** Live state lives in a `Map<code, Room>`. Every state change and answer is persisted asynchronously (batched), so a restart can rebuild rooms from SQLite.
- **One process, no cluster.** This avoids cross-process state sync and comfortably handles 10k+ sockets. Simplicity beats scale-out at this size.

---

## 5. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS (alpine image) | Fast, small image, team-familiar |
| HTTP | Fastify 5 | Low overhead, schema validation built in |
| Realtime | `ws` (raw WebSocket) | Lightest option; no Socket.IO overhead |
| Validation | `zod` (or Fastify JSON schemas) | Reject malformed messages early |
| DB | SQLite via `better-sqlite3`, WAL mode | Sync, very fast, zero ops |
| Frontend | Vite + Preact + TypeScript | ~15 KB runtime; fast on cheap phones |
| Styling | Plain CSS with Yuyu Design System tokens | No framework weight |
| QR | `qrcode` (server-generated SVG) | No client lib needed |
| CSV | `papaparse` (import), hand-rolled export | Small |
| Proxy/TLS | Caddy 2 | Automatic HTTPS, WebSocket support built in |
| Load test | Node script using `ws` (250 bots) | Simulates real game flow, not just pings |

Target bundle sizes: participant JS < 40 KB gzipped, CSS < 10 KB.

---

## 6. Persistence — SQLite decision

- Peak write load is ~200 answer inserts in 1–2 s. SQLite WAL handles thousands of inserts/s.
- Only one process writes, so there is **no lock contention**.
- Answers are queued in memory and flushed in **one transaction every 100 ms**.
- Players never wait on the DB; acknowledgements come from in-memory state.
- Settings: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`.
- Backup: `sqlite3 data/cloud9.db ".backup data/backup-$(date +%s).db"`, or copy the volume after the event.
- **Fallback:** data access is isolated in `src/db/` behind a small repository interface, so switching to Postgres is a contained change if needed.

---

## 7. Data model

```sql
moderators   (id TEXT PK, username TEXT UNIQUE, display_name TEXT, is_super INTEGER, created_at)
-- seeded from env MODERATORS on boot; password hashes stay in memory (scrypt) — not in DB

quizzes      (id TEXT PK, moderator_id TEXT, title TEXT, email_mode TEXT CHECK(email_mode IN ('off','optional','required')),
              created_at, updated_at)

questions    (id TEXT PK, quiz_id TEXT, position INTEGER, text TEXT, image_url TEXT,
              options_json TEXT,           -- ["A","B","C","D"]
              correct_index INTEGER, time_limit_sec INTEGER DEFAULT 20, points_max INTEGER DEFAULT 1000)

sessions     (id TEXT PK, code TEXT, quiz_id TEXT, moderator_id TEXT,
              label TEXT, listed INTEGER DEFAULT 1, join_open INTEGER DEFAULT 1,
              state TEXT, current_q INTEGER, q_started_at INTEGER, q_ends_at INTEGER,
              created_at, ended_at)
              -- UNIQUE(code) only among active sessions (enforced in app)

players      (id TEXT PK, session_id TEXT, name TEXT, email TEXT, token_hash TEXT,
              score INTEGER DEFAULT 0, kicked INTEGER DEFAULT 0, joined_at)

answers      (session_id TEXT, player_id TEXT, question_id TEXT, choice INTEGER,
              correct INTEGER, response_ms INTEGER, points INTEGER, answered_at INTEGER,
              PRIMARY KEY (session_id, player_id, question_id))
```

Indexes: `players(session_id)`, `answers(session_id, question_id)`, `sessions(code)`.

---

## 8. Room state machine

```
 LOBBY ──start──► QUESTION ──(timer ends | all answered | mod "close")──► CLOSED
   ▲                  ▲                                                     │
   │                  └───────────── next ◄── LEADERBOARD ◄──reveal── REVEAL ◄┘
   │                                    │
   └── (new session)                    └── last question ──► FINISHED
```

- `LOBBY`: players join; moderator sees the list and can kick.
- `QUESTION`: server sets `q_started_at` and `q_ends_at`, broadcasts the question **without** the correct index.
- `CLOSED`: answers are locked. The moderator sees the distribution; players see "Time's up".
- `REVEAL`: the correct answer and per-player result are pushed (each player gets their own points and rank).
- `LEADERBOARD`: top 10 broadcast; the moderator can skip this step.
- `FINISHED`: final podium; CSV available.

Invalid transitions are rejected server-side. Moderator actions are **idempotent** (double-clicking "Next" doesn't skip a question; each action carries the expected current question index).

---

## 9. Realtime protocol (WebSocket, JSON)

Endpoint: `wss://<host>/ws?role=player|mod|present&code=123456&token=...`

Envelope: `{ "t": "<type>", ...payload }`. Every server message carries `v` (room state version) so clients can drop stale updates.

### Client → server
| type | role | payload |
|---|---|---|
| `join` | player | `{ name, email? }` → returns `{ playerId, token }` (first join only, over HTTP is also fine) |
| `answer` | player | `{ qIndex, choice }` |
| `ping` | any | `{}` (heartbeat every 20 s) |
| `mod:start` / `mod:next` / `mod:close` / `mod:reveal` / `mod:leaderboard` / `mod:end` | mod | `{ expectQ }` |
| `mod:kick` | mod | `{ playerId }` |

### Server → client
| type | to | payload |
|---|---|---|
| `state` | all | full snapshot for that role (sent on connect/reconnect) |
| `lobby` | mod, present | `{ count, players: [{id,name}] }` (throttled 250 ms) |
| `question` | all | `{ qIndex, total, text, imageUrl, options, endsAt, serverNow }` |
| `answered` | player | `{ qIndex, choice }` (ack) |
| `progress` | mod, present | `{ answered, total }` (throttled 250 ms) |
| `closed` | all | `{ qIndex, distribution? (mod/present only) }` |
| `reveal` | player | `{ correctIndex, yourChoice, correct, points, score, rank }` |
| `reveal` | mod, present | `{ correctIndex, distribution, fastest: [...] }` |
| `leaderboard` | all | `{ top: [{name, score}] , you?: {rank, score} }` |
| `finished` | all | final podium (+ `you` for players) |
| `kicked` | player | `{}` |
| `error` | any | `{ code, message }` |

**Clock sync:** clients compute `offset = serverNow - Date.now()` and render the countdown from `endsAt`. Scoring uses the server receive time only.

---

## 10. HTTP API

```
POST   /api/auth/login                 {username, password} → httpOnly session cookie
POST   /api/auth/logout
GET    /api/me

GET    /api/quizzes                    (mod's own; super sees all)
POST   /api/quizzes                    create
GET    /api/quizzes/:id
PUT    /api/quizzes/:id                full replace (title, email_mode, questions[])
DELETE /api/quizzes/:id
POST   /api/quizzes/import             multipart CSV or JSON → quiz
GET    /api/quizzes/template.csv       sample CSV

POST   /api/sessions                   {quizId, label?, listed?} → {code, joinUrl}
GET    /api/sessions                   mod's active/past sessions
PATCH  /api/sessions/:code             {label?, listed?, joinOpen?}  (mod only)
GET    /api/sessions/:code/qr.svg      QR for join URL
GET    /api/sessions/:code/export.csv  results

GET    /api/public/sessions            listed, non-finished sessions:
                                       [{code, title, label, state, qIndex, total, players, joinOpen}]
                                       built from in-memory rooms, cached 2 s, no PII, no auth
POST   /api/play/:code/join            {name, email?} → {playerId, token}  (rate-limited)
GET    /api/play/:code                 {exists, state, emailMode, title}   (for the join screen)

GET    /healthz                        liveness + room/socket counts
```

### CSV import format
```csv
question,option_a,option_b,option_c,option_d,correct,time_sec,image_url
What is 2+2?,3,4,5,,B,20,
Capital of Kerala?,Kochi,Thiruvananthapuram,Kozhikode,Thrissur,B,15,
```
`correct` accepts A–D or 1–4. Blank options are dropped (min 2). `time_sec` defaults to 20.

---

## 11. Scoring

```
if correct:
  ratio  = clamp(response_ms / (time_limit_ms), 0, 1)
  points = round(points_max * (1 - ratio / 2))     // 1000 → 500
else:
  points = 0
```
- `response_ms = server_receive_time - q_started_at` (server clock only).
- One answer per player per question (first one wins; enforced in memory and by the DB primary key).
- Answers arriving after `q_ends_at + 300 ms` grace are rejected.
- Tie-break on the leaderboard: higher score, then lower total response time, then earlier join.
- Optional toggle per quiz: flat scoring (correct = 1000).

---

## 12. Reliability & reconnects

- **Player token**: random 24 bytes, stored in `localStorage` per room code. Only a hash is stored on the server. Reconnecting with the token restores the same player and score. Email groups event scores and does not grant access to a previous player entry.
- **Snapshot on connect**: every (re)connection gets a full `state` message, so the client never depends on missed events.
- **Client reconnect**: exponential backoff (0.5 s → 5 s max, with jitter); reconnects immediately on `visibilitychange` / `online` events.
- **Heartbeats**: the server pings every 20 s and drops dead sockets after 2 missed pings.
- **Moderator from several devices**: multiple mod sockets per room are allowed (e.g. laptop + phone).
- **Server restart**: on boot, non-finished sessions and results from the last six hours are rebuilt from SQLite into memory. An open question is moved to `CLOSED` so the moderator can continue.
- **Crash safety**: every inbound message is schema-validated inside try/catch, plus process-level handlers. Docker uses `restart: unless-stopped`.
- **Duplicate names**: allowed, but suffixed for display (`Anu`, `Anu (2)`).

---

## 13. Security

- Moderator passwords from env, hashed with scrypt at boot. Session cookies are signed, revocable, `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS.
- Moderators can act only on rooms they own (super-admin can act on all).
- Rate limits: join 1000/min/IP by default; answer 1 per question per player (anything extra is dropped); WS messages 20/s/socket (above that, disconnect).
- Name max 24 chars, email max 120 chars and format-checked, all output escaped (Preact escapes by default).
- Room codes are 6 random digits; join requires the room to be in `LOBBY` (late join allowed, toggle on by default, scoring 0 for missed questions).
- No player PII in logs. The CSV export (which includes emails) requires the moderator's auth.
- Max players per room: 500 (configurable).
- The public session list exposes only title, label, status and player count: never names, emails or answers. The 6-digit code is visible for listed sessions by design; use "Show on home page: off" for private rooms.

---

## 14. Performance budget

| Resource | Estimate @ 250 players across 5 rooms |
|---|---|
| RAM (Node) | ~80–120 MB (sockets ~40 KB each + heap) |
| RAM (Caddy) | ~30 MB |
| CPU | Spikes < 30% of one vCPU on broadcast/answer bursts |
| Broadcast cost | 250 × ~300 B payload = trivial; done with a pre-serialised string |
| DB writes | 1 batched transaction / 100 ms |
| Home-page polling | 200 idle browsers ÷ 5 s = ~40 req/s, served from a 2 s in-memory cache (no DB hit) |

Tactics:
- Serialise each broadcast once and send the same string to all sockets.
- Throttle `lobby` and `progress` updates to 4 per second.
- `permessage-deflate` **off** (saves CPU; payloads are tiny).
- Static assets: immutable hashed filenames, `Cache-Control: max-age=31536000`, gzip/brotli via Caddy.
- Container limits: `mem_limit: 2g`, `cpus: 2.0`, Node heap 1.5 GB.

---

## 15. Frontend structure & screens

```
web/
  src/
    main.tsx            routes: / (home: live session list + code box), /join/:code, /play/:code, /mod, /mod/quiz/:id, /mod/room/:code, /present/:code
    lib/ws.ts           reconnecting WS client + clock offset
    lib/api.ts
    styles/tokens.css   Yuyu Design System tokens (colours, type, spacing, radius)
    styles/base.css
    pages/home/         Home (session cards, code box, empty state)
    pages/player/       Join, Lobby, Question, Locked, Result, Final
    pages/mod/          Login, Dashboard, QuizEditor, Import, Room (control panel)
    pages/present/      Present
```

**Home screen** (mobile-first):
```
┌──────────────────────────────┐
│ Cloud 9                      │
│ [ Have a code?  ______ → ]   │
│                              │
│ Live now                     │
│ ┌──────────────────────────┐ │
│ │ Tech Trivia              │ │
│ │ Hall A · Round 1         │ │
│ │ ● Waiting · 42 players   │ │
│ │                 [ Join ] │ │
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ Cloud Quiz               │ │
│ │ Hall B                   │ │
│ │ ● Q3 of 10 · 37 players  │ │
│ │               [ Rejoin ] │ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

**Participant screens** (mobile-first, one action per screen):
1. Join: code (pre-filled from the home page or QR), name, email (if enabled), "Join" button
2. Lobby: "You're in, {name}" + player count + a calm waiting state
3. Question: progress (3/10), timer bar, question, 2–4 full-width buttons
4. Locked: "Answer locked", with the chosen option highlighted
5. Result: ✓/✗, +points, rank
6. Final: rank, score, "Thanks for playing"

**Moderator room screen** (laptop-first, also works on phone):
- Left: QR + code + join URL + copy button; player count/list
- Main: current question preview, timer, live answered counter, distribution bars after close
- Bottom: one primary action button that changes label with state (Start → Close → Reveal → Leaderboard → Next → End), with keyboard shortcut `Space`/`→`
- Secondary: kick, end session, export CSV, open Present mode
- Session settings: label, "Show on home page" toggle, "Joining open" toggle

**Moderator dashboard:** list of their quizzes with a **Start session** button, and their active sessions with a live player count, listed/hidden badge and quick toggles.

**Design:** follow the Yuyu Design System: same tokens, type scale, radius and minimal chrome. High contrast, large tap targets (≥ 56 px), works in light/dark.

---

## 16. Repo structure

```
cloud9/
  shared/               protocol.ts, api.ts, model.ts (contracts, imported by server + web)
  dev/                  mock-server.ts (scripted game for UI work)
  server/
    src/
      index.ts          boot: config, db, http, ws
      config.ts         env parsing (zod)
      db/               schema.sql, migrate.ts, repo.ts (all SQL here)
      auth/             moderators.ts, session.ts
      http/             routes.quizzes.ts, routes.sessions.ts, routes.play.ts, routes.auth.ts
      realtime/         hub.ts (sockets), protocol.ts (zod schemas), throttle.ts
      game/             room.ts (state machine), scoring.ts, registry.ts (Map<code,Room>), restore.ts
      util/             ids.ts, csv.ts, rateLimit.ts, log.ts
    package.json
  web/                  (see §15)
  loadtest/
    bots.ts             N bots join, answer randomly with human-like delays
    run.sh
  docker/
    Caddyfile
  Dockerfile            multi-stage: build web + server → node:22-alpine runtime
  docker-compose.yml
  .env.example
  README.md             setup, deploy, event-day runbook
```

---

## 17. Deployment

### `.env`
```
PUBLIC_URL=https://quiz.example.com
SESSION_SECRET=<random 32+ chars>
MODERATORS=admin:<pass>:super,anu:<pass>,rahul:<pass>
DB_PATH=/data/cloud9.db
PORT=3000
```

### `docker-compose.yml` (outline)
```yaml
services:
  app:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes: [ "./data:/data" ]
    mem_limit: 2g
    cpus: 2.0
    expose: [ "3000" ]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 15s
  caddy:                      # remove if a reverse proxy already exists
    image: caddy:2-alpine
    restart: unless-stopped
    ports: [ "80:80", "443:443" ]
    volumes: [ "./docker/Caddyfile:/etc/caddy/Caddyfile", "caddy_data:/data" ]
volumes: { caddy_data: {} }
```

### Caddyfile
```
{$DOMAIN} {
  encode zstd gzip
  reverse_proxy app:3000
}
```
If the server already runs Nginx/Traefik: drop `caddy`, publish `127.0.0.1:3000`, and add a proxy block with `Upgrade`/`Connection` headers for `/ws`, plus `proxy_read_timeout 3600s`.

### Deploy steps
1. `git clone` → `cp .env.example .env` → fill it in
2. Point DNS A record at the server (only needed for HTTPS)
3. `docker compose up -d --build`
4. `curl https://<domain>/healthz`
5. Until the domain is ready: test on `http://<server-ip>:3000` (expose the port temporarily)

---

## 18. Testing plan

### Automated (before handover)
- Unit: scoring, state transitions, CSV import parsing, duplicate-answer rejection
- Integration: one room, 3 bots, full game end-to-end over real WS

### Load test (`loadtest/bots.ts`)
- **Scenario A:** 1 room × 250 bots — join burst over 10 s, 10 questions, all answering within 1–3 s
- **Scenario B:** 5 rooms × 50 bots running at the same time, staggered
- **Scenario C:** churn — 20% of bots disconnect and reconnect mid-question
- Pass criteria: 0 errors, p95 answer-ack < 150 ms, broadcast fan-out < 100 ms, RAM < 250 MB, CPU < 70% of one core, no score drift after reconnects
- Report: printed table + `docker stats` capture

### Live test (with real phones, on the server)
- 5–15 people on mixed Android/iOS, Wi-Fi and mobile data
- Checklist: home page shows both live rooms and the Join button works, hidden room absent from the list, QR scan → join, lock-screen and come back, refresh mid-question, airplane mode for 10 s, two moderators running two rooms at once, CSV export opens correctly in Sheets

---

## 19. Build timeline (tonight)

| # | Milestone | ETA | Done when |
|---|---|---|---|
| M0 | Repo scaffold, Dockerfile, compose, config | 15 min | `docker compose up` serves `/healthz` |
| M1 | DB schema + repo + moderator auth | 20 min | Login works, quizzes CRUD via API |
| M2 | Room engine + scoring + WS hub + protocol | 40 min | 3-bot integration test plays a full game |
| M3 | CSV import + QR + export | 15 min | Template round-trips; QR scans |
| M4 | Home page (live session list) + participant UI | 45 min | Tap Join on home → full game playable on a phone |
| M5 | Moderator UI (dashboard, editor, room control) | 40 min | Moderator can run a game end-to-end |
| M6 | Present mode | 15 min | Projector view follows the game |
| M7 | Restore-on-restart + hardening (rate limits, validation) | 15 min | Kill container mid-game → resume works |
| M8 | Load test A/B/C + fixes | 25 min | Pass criteria met; report sent |
| M9 | README + runbook + handover | 10 min | Deployed by you; live test begins |

**Total ≈ 3.7 h if built one step at a time.** With parallel subagents (§19a) this drops to **≈ 2 h**. M6 (present mode) is the first thing to cut if time runs short.

---

## 19a. Parallel build with subagents

The build is split so that up to five subagents work at the same time, each owning separate folders. The lead agent (me) writes the shared contracts first, so every agent builds against the same types and nobody waits on anyone else.

### Phase 0: Contracts (lead, ~20 min, blocks everything else)
Written into `shared/` and frozen before the agents start:
- `shared/protocol.ts`: every WebSocket message type and payload (§9) as TypeScript types + zod schemas
- `shared/api.ts`: request/response types for every HTTP route (§10), including `/api/public/sessions`
- `shared/model.ts`: Room, Player, Question, SessionSummary, state enum, scoring constants
- `server/src/db/schema.sql` (§7)
- Repo scaffold: `package.json` workspaces, tsconfig, Vite config, empty folders, `tokens.css` with Yuyu tokens
- A **mock server** (`dev/mock-server.ts`) that replays a scripted game over the real protocol, so the UI agents can build and test screens without waiting for the backend

Changing a contract after Phase 0 goes through the lead only, who tells the affected agents.

### Phase 1: Parallel agents (~60 min, all at once)

| Agent | Owns (writes only here) | Builds | Done when |
|---|---|---|---|
| **A · Game engine** | `server/src/game/`, `server/src/realtime/` | Room state machine, scoring, timers, WS hub, broadcast throttling, reconnect/token rebind, restore-on-restart | 3-bot integration test plays a full game; unit tests pass |
| **B · API & data** | `server/src/http/`, `server/src/db/repo.ts`, `server/src/auth/`, `server/src/util/` | DB repo + batched writer, moderator auth, quiz CRUD, CSV import/export, QR, public session list, rate limits | API tests pass with `curl`/vitest |
| **C · Player UI** | `web/src/pages/home/`, `web/src/pages/player/`, `web/src/lib/ws.ts` | Home page (live list, Join/Rejoin, code box), join, lobby, question, locked, result, final; reconnecting WS client | Full game playable on a phone against the mock server |
| **D · Moderator UI** | `web/src/pages/mod/`, `web/src/pages/present/` | Login, dashboard, quiz editor, CSV import, room control panel with session toggles, present mode | Moderator can run a full game against the mock server |
| **E · Ops & load test** | `Dockerfile`, `docker-compose.yml`, `docker/`, `loadtest/`, `README.md` | Multi-stage Dockerfile, compose, Caddyfile, `.env.example`, 250-bot load script (scenarios A/B/C), runbook | `docker compose up` builds; load script runs against the mock server |

Rules for the agents:
- Each agent writes only inside its own folders. `shared/` is read-only for them.
- Each agent runs in its own git worktree/branch, so there are no file clashes.
- Each finishes with a short report: what's done, what's stubbed, and anything that needs a contract change.

### Phase 2: Integration (lead, ~25 min)
1. Merge branches A → B → E → C → D (backend first, then UIs)
2. Wire `index.ts` (Fastify + WS + static files) and point the UIs at the real server instead of the mock
3. Run the 3-bot integration test, then click through a full game in a browser (moderator + 2 phones + home page)

### Phase 3: Verify (~20 min, two agents in parallel)
- **Agent E** runs load scenarios A/B/C against the real container and reports the numbers vs the pass criteria in §18
- **A fresh review agent** (one that hasn't seen the build) reads the code against this plan and checks for crash paths, unvalidated input, scoring bugs and anything that would break with 200 players
- Lead fixes what they find, then hands over for deploy

### Timeline with subagents

| Time (from start) | What's happening |
|---|---|
| 0:00–0:20 | Phase 0: contracts + scaffold + mock server |
| 0:20–1:20 | Phase 1: agents A–E in parallel |
| 1:20–1:45 | Phase 2: merge + integration |
| 1:45–2:05 | Phase 3: load test + independent review + fixes |
| ~2:05 | Ready for you to deploy and live-test |

### Risks of the parallel approach
- **Contract drift:** agents interpret the protocol differently → prevented by the shared zod schemas, which both server and client import.
- **Integration surprises:** UIs built against the mock may differ from the real server → the mock uses the same `shared/` schemas and is validated against them.
- **Merge conflicts:** prevented by strict folder ownership.

---

## 20. Event-day runbook

**Before doors (T-60 min)**
- `docker compose ps` all healthy; `/healthz` OK
- Each moderator logs in, imports their quiz, does a 2-question dry run
- Back up the DB: `docker compose exec app sqlite3 /data/cloud9.db ".backup /data/pre-event.db"`

**During**
- Watch: `docker stats` and `docker compose logs -f app`
- If a phone is stuck: refresh, and the player rejoins automatically
- If the server restarts: rooms are restored, and the moderator presses "Next/Reveal" to continue
- Moderator laptop dies: log in on another device, open the same room, carry on

**After**
- Export CSVs per room
- Copy `./data/cloud9.db` off the server

---

## 21. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Venue network flaky | Medium | Tiny payloads, auto-reconnect, server-side timers, grace window |
| Moderator double-clicks / wrong action | Medium | Idempotent actions with `expectQ`, confirm on "End session" |
| Server restart mid-game | Low | Restore from SQLite, Docker auto-restart |
| Proxy kills idle WebSockets | Medium | 20 s heartbeats; long proxy read timeout |
| Port 80/443 already taken on the server | Medium | Use the existing proxy instead of Caddy (see §17) |
| Scope creep tonight | High | Strict v1 list; present mode cut first |
| Other workloads starve CPU | Low | Generous limits (2 GB / 2 CPUs); load test on the real box |

---

## 22. After the event (v1.1+ ideas)

- Question types: multi-select, true/false, poll (no correct answer), type-in answer
- Reusable question banks, duplicate quiz
- Team mode, streak bonuses
- Postgres adapter for multi-instance deploys
- Moderator-invite flow instead of env-defined accounts
- Simple results page per player (shareable link)

---

## 23. Open questions

1. Confirm defaults in §3 (or adjust)
2. Final list of moderator usernames
3. Does the Hetzner box already run a reverse proxy on 80/443?
4. Domain/subdomain to use (can come later)
5. Is present mode needed tomorrow, or is the moderator screen enough?
