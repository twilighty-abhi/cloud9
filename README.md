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
| **Existing Nginx** on the host | Copy `docker/nginx.conf.example` to `/etc/nginx/sites-available/cloud9`, set `server_name`, enable it, `sudo nginx -t && sudo systemctl reload nginx`, then `sudo certbot --nginx -d quiz.example.com`. The `/ws` block (Upgrade headers, `proxy_read_timeout 3600s`) is required. |
| **Caddy** (ports 80/443 free) | Set `DOMAIN=` in `.env`, point the DNS A record at the server, then `docker compose --profile caddy up -d --build`. Certificates are automatic. |
| **Direct IP** (testing only) | In `docker-compose.yml` change the port to `"3000:3000"`, set `PUBLIC_URL=http://<server-ip>:3000`, `docker compose up -d`, open `http://<server-ip>:3000`. Revert before the event (plain HTTP, no Secure cookies). |

`PUBLIC_URL` must be the exact URL players open: join links and QR codes are built from it.
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
`ALLOWED_ORIGINS` (comma-separated): extra browser Origins allowed to open moderator WebSockets besides `PUBLIC_URL`;
add any secondary domain moderators use (e.g. `https://cloud9.abhiramnj.com`). A page on the same host as the request is
also accepted, but only if the proxy passes the `Host` header through. A moderator room screen opened from any other Origin
shows "unauthorized". Players and projector screens are not affected.
`PORT`, `DB_PATH`, `WEB_DIST` are fixed inside the container. Optional Telegram bot: `TELEGRAM_*` (see [docs/TELEGRAM.md](docs/TELEGRAM.md)).
