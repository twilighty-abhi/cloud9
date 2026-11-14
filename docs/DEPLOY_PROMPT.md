# Deploy prompt (template)

A prompt you can give an AI agent (or follow by hand) to deploy Cloud 9 to a fresh or shared Linux server.
Fill in the placeholders first. Keep the filled-in copy **private** (password manager / private notes), not in this
public repo: it names your server and access method.

| Placeholder | Example | Meaning |
|---|---|---|
| `<SERVER_IP>` | `203.0.113.10` | server's public IP |
| `<SSH_USER>` | `deploy` | a sudo user with SSH key login (not root, no password auth) |
| `<PRIMARY_DOMAIN>` | `quiz.example.org` | the domain players use (`PUBLIC_URL`) |
| `<SECONDARY_DOMAIN>` | `quiz.example.net` | optional second name; redirect it to the primary when you can |
| `<DEPLOY_DIR>` | `/opt/cloud9` | where the repo is cloned |
| `<BACKUP_REMOTE>` | `rclone:r2:cloud9-backups` | off-box backup target for `docker/backup.sh` |

---

Deploy "Cloud 9" (a live quiz web app) to my server over SSH and get it production-ready for an event (~200 concurrent
players). Work carefully: this server may already run other workloads that must NOT be disturbed.

Server: `ssh <SSH_USER>@<SERVER_IP>` (use sudo). The cloud9 container is allowed up to 2 GB RAM / 2 CPUs
(docker-compose.yml); real use is ~150–200 MB. If free RAM on the box is under 2.5 GB, tell me before starting.
Repo: https://github.com/twilighty-abhi/cloud9.git (public)
Domain: `<PRIMARY_DOMAIN>` (optionally also `<SECONDARY_DOMAIN>`).
Moderator accounts: admin (super) only for now; I will add hall moderators later (tell me how in the final report).

Read README.md first; it has the deploy steps, the event-day runbook, backup/restore and rollback.

Steps:
1. Recon (read-only first): OS, `docker --version`, `docker compose version`, free RAM/disk, `docker ps`, and what is
   listening on 80/443/3000 (`ss -ltnp`). Tell me what you found before changing anything. Do NOT stop, restart, or
   modify any existing container, service, or proxy config without asking me.
2. Install Docker + the compose plugin only if missing.
3. `sudo git clone https://github.com/twilighty-abhi/cloud9.git <DEPLOY_DIR>`.
4. Create `<DEPLOY_DIR>/.env` from `.env.example`:
   - `PUBLIC_URL=https://<PRIMARY_DOMAIN>`
   - `SESSION_SECRET` = `openssl rand -hex 32`
   - `MODERATORS` = the accounts above with strong random passwords (`openssl rand -hex 12`; hex avoids `$` / `,`
     problems), format `admin:PASS:super,mod1:PASS,...`
   - `JOIN_RATE_PER_MIN=1000`, `LOGIN_RATE_PER_MIN=20` (venue Wi-Fi shares one IP)
   - For a Telegram group: `TELEGRAM_NOTIFY_QUESTIONS=0` (groups are limited to ~20 messages/min).
   - `chmod 600 .env`. Give me the moderator passwords once, through a private channel; do not write them into
     any file other than `.env`.
5. `sudo mkdir -p data && sudo chown 1000:1000 data && sudo chmod 750 data` (container runs as uid 1000), then build and
   start a tagged image (README "Update & rollback" if present, else `docker compose up -d --build`). Check
   `docker compose ps` is healthy and `curl -s localhost:3000/healthz` returns ok. Keep the port bound to
   `127.0.0.1:3000`; never publish 3000 on the public interface (Docker-published ports bypass ufw).
6. DNS + TLS: tell me the DNS records to add (A records for `<PRIMARY_DOMAIN>` [and `<SECONDARY_DOMAIN>`] →
   `<SERVER_IP>`; if the DNS is on Cloudflare, "DNS only" so WebSockets and certificate issuance work simply). Poll
   `dig +short <PRIMARY_DOMAIN>` until it returns the server IP. Then:
   - If Nginx already owns 80/443: get a cert the way the server already does it (e.g.
     `certbot certonly --nginx -d <PRIMARY_DOMAIN> [-d <SECONDARY_DOMAIN>]`), add a site from
     `docker/nginx.conf.example` with the placeholders filled in, show me the diff, run `nginx -t` BEFORE reloading.
   - If 80/443 are free: `DOMAIN=<PRIMARY_DOMAIN> docker compose --profile caddy up -d`.
   Confirm `https://<PRIMARY_DOMAIN>/` loads and a new session's QR / join link uses the domain.
   To test before DNS works, use an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 <SSH_USER>@<SERVER_IP>`), not a public port.
7. Verify from outside: home page loads, WebSocket works (log in at /mod, import the CSV template, start a session,
   open /join/<code> on a phone on mobile data, play 2 questions). Then delete that test quiz.
8. Load test pointed directly at the app (not through the proxy), ideally from a laptop through the SSH tunnel so bots
   don't use the server's CPU: `npx tsx loadtest/bots.ts --url http://127.0.0.1:3000 --user admin --pass <admin-pass> --scenario C`
   while watching `docker stats`. Report the PASS/FAIL table, peak CPU % and RAM, and confirm other workloads stayed healthy.
9. Backups: run `docker/backup.sh` once (README "Backup & restore"; backups go to `/var/backups/cloud9`, outside
   `./data`), install `docker/cron.example` as `/etc/cron.d/cloud9-backup` with `BACKUP_REMOTE=<BACKUP_REMOTE>`, and do
   one restore drill (`bash docker/test-backup-restore.sh` locally; a real restore only on a non-live copy). If those
   scripts are not in the checkout, use the node `.backup()` one-liner from the README runbook and copy the file off the box.
10. Hardening check: SSH key-only (`PasswordAuthentication no`, `PermitRootLogin prohibit-password` or `no`), firewall
    allows only 22/80/443, `ss -ltnp | grep 3000` shows 127.0.0.1 only.
11. Final report: URL(s), how to view logs / restart / update / roll back / back up / restore, load test numbers, and
    anything I must do by hand (DNS, provider firewall).

Safety: never run `docker system prune`, never remove volumes or `./data`, never edit other apps' configs without
showing me the change first, and ask before anything irreversible.
