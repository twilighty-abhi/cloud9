# Cloud 9

Lightweight live quiz platform (Kahoot-style): moderators run rooms, players scan a QR, type a name and play on their phones.
One Node process (Fastify + WebSockets + SQLite), one Docker container, built for 200+ concurrent players on a small VPS.

## Local development

```bash
npm install
npm run dev:server     # API + WS on http://localhost:3000 (MODERATORS defaults to admin:admin)
npm run dev:web        # Vite dev server for the UI (proxies /api and /ws to :3000)
npm test               # unit + integration tests
```

Production build: `npm run build && npm start` (serves `dist/web` + `dist/server.mjs`).

## Deploy on the Hetzner box

```bash
git clone <repo-url> cloud9 && cd cloud9
cp .env.example .env
openssl rand -hex 32            # paste into SESSION_SECRET
nano .env                       # PUBLIC_URL, MODERATORS (real passwords!), DOMAIN if using Caddy
mkdir -p data && sudo chown 1000:1000 data   # container runs as uid 1000 (node); root-owned ./data → SQLITE_CANTOPEN crash loop
docker compose up -d --build    # app only, bound to 127.0.0.1:3000
docker compose ps               # wait for "healthy"
curl -s localhost:3000/healthz  # {"ok":true,"rooms":0,"sockets":0,...}
```

The container runs as the `node` user (uid 1000). If `./data` was created by root and the app logs
`SQLITE_CANTOPEN`, run `sudo chown -R 1000:1000 data`.

Then pick **one** way to expose it:

| Option | How |
|---|---|
| **Existing Nginx** on the host (what production uses) | Get a cert first (`sudo certbot certonly --nginx -d <PRIMARY_DOMAIN> [-d <SECONDARY_DOMAIN>]`), copy `docker/nginx.conf.example` to `/etc/nginx/sites-available/cloud9`, replace the domain placeholders, enable it, `sudo nginx -t && sudo systemctl reload nginx`. The `/ws` block (Upgrade headers, long timeouts) and `X-Forwarded-For $remote_addr` are required. |
| **Caddy** (ports 80/443 free) | Set `DOMAIN=` in `.env`, point the DNS A record at the server, then `docker compose --profile caddy up -d --build`. Certificates are automatic. |
| **Direct IP** (testing only) | In `docker-compose.yml` change the port to `"3000:3000"`, set `PUBLIC_URL=http://<server-ip>:3000`, `docker compose up -d`, open `http://<server-ip>:3000`. Revert before the event (plain HTTP, no Secure cookies). |

`PUBLIC_URL` must be the exact URL players open: join links and QR codes are built from it.

### Domains

Production's primary domain is **`https://cloud9.gdgcloudkochi.com`**: set `PUBLIC_URL` to it, and share only links and
QR codes on it. An older secondary domain still serves the same app and some moderators use it. Each origin has its own
browser storage, so a player who switches domains rejoins as a new player and a moderator has to log in again. Once
nobody uses the secondary, redirect it to the primary (optional server block in `docker/nginx.conf.example`).
Changing `.env` needs `docker compose up -d` (recreates the container), not just `restart`.

Update to a new version: `git pull && docker compose up -d --build`. Live rooms are restored from SQLite on boot.

Resource limits (compose): 2 GB RAM, 2 CPUs, Node heap up to 1.5 GB (real use ~130 MB at 250 players), logs rotated at 10 MB × 3.

## Creating quizzes

Log in at `/mod`, then either build a quiz in the editor or **Import** a CSV/JSON file
(a template is at `/api/quizzes/template.csv`):

```csv
question,option_a,option_b,option_c,option_d,correct,time_sec,image_url
What is 2+2?,3,4,5,,B,20,
Capital of Kerala?,Kochi,Thiruvananthapuram,Kozhikode,Thrissur,B,15,
```

- `correct`: `A`–`D` or `1`–`4` (case-insensitive)
- blank options are dropped (min 2, max 4)
- `time_sec`: 5–300, default 20; `image_url` optional
- quote any field that contains commas (`"Hello, world"`); save as UTF-8

Start a session from the quiz, then show the QR / code. Toggle "Show on home page" off for private rooms.

## Events

An **event** groups the quizzes and sessions of one conference (for example several halls running at the same time) under
one shared leaderboard.

- Create the event on the `/mod` dashboard (**+ New event**), then pick it as the quiz's event in the editor or on
  import. Every session started from an event quiz belongs to that event.
- Players in event sessions must enter an email at join. The email is their identity across sessions, so scores from
  every hall add up on the event leaderboard (a player who rejoins with the same email is rebound to their entry).
- The moderator Event page shows the full leaderboard (with emails) and a CSV export (`/api/events/<id>/export.csv`).
  Keep that CSV private.
- Projector board: `/present/event/<id>` shows the public event leaderboard (top 10, names only, no emails).
  Players see top-3 boards on their phones.

## Load test

`loadtest/bots.ts` plays full games with bot moderators and players over the real API + WebSocket,
then prints a PASS/FAIL table (also saved to `loadtest/last-report.json`, exit code 1 on FAIL).

```bash
npx tsx loadtest/bots.ts --url http://localhost:3000 --user admin --pass <pw> --scenario A   # 1 room × 250
npx tsx loadtest/bots.ts --url http://localhost:3000 --user admin --pass <pw> --scenario B   # 5 rooms × 50
npx tsx loadtest/bots.ts --url http://localhost:3000 --user admin --pass <pw> --scenario C   # B + 20% reconnect churn
npx tsx loadtest/bots.ts --help                                                             # all flags
```

Pass criteria (PLAN §18): 0 join/WS/answer/moderator errors, answer-ack p95 < 150 ms, broadcast fan-out p95 < 100 ms,
server RSS < 250 MB, no score drift after reconnects, all rooms finish. Watch `docker stats` in a second terminal
for CPU (target < 70 % of one core).

Notes:
- Target the app **directly** (`127.0.0.1:3000`), not through Caddy/Nginx: bots send a fake `X-Forwarded-For`
  per player to get past the join rate limit (`JOIN_RATE_PER_MIN`, default 1000/min/IP), and proxies replace that header.
- Best run from your laptop through an SSH tunnel so the bots don't steal the server's CPU:
  `ssh -L 3000:127.0.0.1:3000 user@server`, then use `--url http://localhost:3000`.
- Each run creates real quizzes/sessions named "Load test …" (unlisted). Run it before the event, then back up
  or delete `data/cloud9.db` if you want a clean slate (stop the app first).

## Event-day runbook

**T-60 min**
```bash
docker compose ps                       # app (and caddy) "healthy"
curl -s localhost:3000/healthz
docker compose exec app node -e "require('better-sqlite3')('/data/cloud9.db').backup('/data/pre-event.db').then(()=>console.log('ok'))"
```
- Each moderator logs in, imports their quiz, runs a 2-question dry run on their phone.
- Check the home page lists the public rooms and the QR opens the join screen on mobile data (not just venue Wi-Fi).

**During**
```bash
docker stats                            # RAM ~130–200 MB at 250 players; limit is 2 GB
docker compose logs -f --tail=100 app   # errors only at LOG_LEVEL=warn
curl -s localhost:3000/healthz          # rooms / sockets / rssMb
```
- **Phone stuck / blank**: refresh. The player token is kept in the browser, so they rejoin with the same score.
- **Player can't join ("rate limited")**: wait a minute; `JOIN_RATE_PER_MIN` joins/min per IP (default 1000). A whole venue behind one NAT is
  fine for normal arrival rates, but if a proxy is misconfigured every player shares the proxy's IP. Check that the
  Nginx config sets `X-Forwarded-For`.
- **Moderator laptop dies**: log in on any device, open the same room from the dashboard, carry on.
  Several mod devices on one room is allowed.
- **A room looks frozen**: moderator reloads the room page (fresh snapshot). If a question is stuck open,
  press Close, then Reveal/Next. As a last resort, End the session and start a new one from the same quiz
  (players rejoin with the new code; scores restart).
- **Whole app misbehaving**: `docker compose restart app`. Live rooms are restored from SQLite; an open question
  comes back as Closed, and the moderator presses Reveal/Next to continue. Players reconnect automatically.
- **Container keeps restarting**: `docker compose logs --tail=200 app`. Usual causes are a bad `.env`
  (MODERATORS format) or `./data` not writable (see the `chown` fix above).

**After**
- Export each room's CSV from the moderator dashboard (includes emails; keep it private).
- Back up and copy the DB off the server:
  ```bash
  docker compose exec app node -e "require('better-sqlite3')('/data/cloud9.db').backup('/data/backup-'+Date.now()+'.db').then(()=>console.log('ok'))"
  scp user@server:~/cloud9/data/backup-*.db .
  ```
  (`.backup()` is safe while the app is running; copying `cloud9.db` directly is only safe after `docker compose stop app`.)

## Telegram bot (optional)

Cloud 9 can post session activity (created / started / finished with leaderboards, results CSV to admins) to a Telegram
group and private chats, with per-hall forum topics, and answer admin commands like `/live`, `/leaderboard`, `/winner`
and `/export <code>`. It is **off unless `TELEGRAM_BOT_TOKEN` is set**, and Telegram outages never affect the quiz
(messages wait in an outbox and are sent later). Groups never see player emails.

Admins can also create a session lobby, turn joining on/off, hide/show a session and end it from Telegram, each with a
confirm tap (starting and running questions stays on the moderator screen).

Setup (BotFather, finding user / group / topic ids, all `TELEGRAM_*` variables, troubleshooting): **[docs/TELEGRAM.md](docs/TELEGRAM.md)**.

## Configuration

All settings are in `.env` (see `.env.example`): `PUBLIC_URL`, `SESSION_SECRET`, `MODERATORS`
(`user:pass[:super],…`), `MAX_PLAYERS_PER_ROOM` (default 500), `LOG_LEVEL`, `DOMAIN` (Caddy only).
`PORT`, `DB_PATH`, `WEB_DIST` are fixed inside the container. Optional Telegram bot: `TELEGRAM_*` (see [docs/TELEGRAM.md](docs/TELEGRAM.md)).
Also `JOIN_RATE_PER_MIN` (default 1000, joins per IP per minute) and `LOGIN_RATE_PER_MIN` (default 5, moderator logins
per IP per minute; the example sets 20). In `.env`, a `$` in a password must be written as `$$` (Compose interpolates
it), so prefer hex passwords (`openssl rand -hex 12`).

## Capacity

Measured in the pre-event load test (one container, 2 vCPU box):

| Limit | Default | Notes |
|---|---|---|
| Players per room | `MAX_PLAYERS_PER_ROOM=500` | Player 501 gets `409 room_full` ("This quiz is full right now"). One room of 600 ran cleanly with the cap raised (ack p95 0.6 ms, CPU ~33 %), so `1000` is safe for a single big keynote room. |
| Joins per IP per minute | `JOIN_RATE_PER_MIN=1000` | Everyone on venue Wi-Fi shares one public IP (NAT), and rejoins after reloads count too. Fine for ~200–600 joins/min; if all halls start in the same minute with more phones than that, set `3000`. The proxy must forward the real client IP (`X-Forwarded-For $remote_addr` in nginx, default in Caddy) or every player shares the proxy's IP. |
| Moderator logins per IP per minute | `LOGIN_RATE_PER_MIN` (example: 20) | Moderators on venue Wi-Fi share one IP. |
| Telegram | ~20 messages/min per group (Telegram's limit) | The sender is serial and rate-limited; with several halls live, per-question lines back up for minutes (no effect on the quiz). Keep `TELEGRAM_NOTIFY_QUESTIONS=0` for group chats and rely on the digest and finish/leaderboard messages. |
| Memory | 2 GB limit | ~150–200 MB RSS at 200–600 players; the DB grows ~300 bytes per answer (a full event day is well under 100 MB). |

## Operations quick reference

Run from the deploy directory (`/opt/cloud9` on the server).

- **Before updating:** do not update while a session is live (the build competes for CPU; open questions come back
  Closed after the swap). Take a backup first (below).
- **Update:** `docker tag cloud9:latest cloud9:prev && git pull && docker compose up -d --build`, then
  `docker compose ps` (healthy) and `curl -s localhost:3000/healthz`.
- **Rollback** to the image from before the update, without rebuilding:
  `docker tag cloud9:prev cloud9:latest && docker compose up -d --no-build`, then `git checkout <old-sha>` so the
  checkout matches. DB migrations are additive, so older code runs on a newer DB.
- **Backup** (safe while live):
  `docker compose exec -T app node -e "require('better-sqlite3')('/data/cloud9.db').backup('/data/backup-'+Date.now()+'.db').then(()=>console.log('ok'))"`,
  then move it out of `./data` (`sudo mv data/backup-*.db /var/backups/cloud9/`) and copy it off the server
  (`scp <user>@<server>:/var/backups/cloud9/backup-*.db .`). If `docker/backup.sh` / `docker/restore.sh` are in your
  checkout, use those instead (verified, rotated, optional off-box copy).
- **Restore:** `docker compose stop app`, move `data/cloud9.db`, `data/cloud9.db-wal` and `data/cloud9.db-shm` into a
  safe folder (all three, or SQLite replays the old WAL onto the restored file), copy the backup to `data/cloud9.db`,
  `sudo chown 1000:1000 data/cloud9.db`, `docker compose up -d --no-build`, check `/healthz` and the dashboard.
