Deploy "Cloud 9" (a live quiz web app) to my server over SSH and get it production-ready for an event TOMORROW (~200 concurrent players). Work carefully: this server already runs other workloads that must NOT be disturbed.

Server: ssh root@65.21.181.247  (Hetzner, 4 GB RAM, 2 vCPU, ~1 GB already used). The cloud9 container is allowed up to 2 GB RAM / 2 CPUs (docker-compose.yml); real use is ~130 MB. If free RAM on the box is under 2.5 GB, tell me before starting.
Repo: https://github.com/twilighty-abhi/cloud9.git (public)
Domain: cloud9.abiramnj.com — DNS is NOT pointed at the server yet; I will add an A record soon (see step 6).
Moderator accounts I want: admin (super) only for now — I will add hall moderators later myself (tell me how in the final report).

Read README.md and docs/PLAN.md in the repo first; README has the deploy steps and the event-day runbook.

Steps:
1. Recon (read-only first): OS, `docker --version`, `docker compose version`, free RAM/disk, `docker ps` (list what's already running), and what is listening on 80/443/3000 (`ss -ltnp`). Tell me what you found before changing anything. Do NOT stop, restart, or modify any existing container, service, or proxy config without asking me.
2. Install Docker + compose plugin only if missing.
3. Clone to /opt/cloud9: `git clone https://github.com/twilighty-abhi/cloud9.git /opt/cloud9` (public repo, no key needed).
4. Create /opt/cloud9/.env from .env.example:
   - PUBLIC_URL = http://localhost:3000 for now (tested through an SSH tunnel) (QR codes and join links use it). Switch to https://cloud9.abiramnj.com in step 6b once DNS works.
   - SESSION_SECRET = `openssl rand -hex 32`
   - MODERATORS = the accounts above with strong random passwords (format admin:PASS:super,mod1:PASS,...)
   - JOIN_RATE_PER_MIN=1000, LOGIN_RATE_PER_MIN=20 (venue Wi-Fi shares one IP)
   - chmod 600 .env. Print the moderator usernames + passwords to me ONCE at the end.
5. `mkdir -p data && chown 1000:1000 data` (container runs as uid 1000), then `docker compose up -d --build`. Check `docker compose ps` is healthy and `curl -s localhost:3000/healthz` returns ok.
6. Expose it in two phases.
   6a. NOW (no DNS yet): keep the app port mapping on "127.0.0.1:3000:3000" (port 3000 must never be published publicly or opened in the firewall). Verify from my laptop through an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 user@65.21.181.247`, then http://localhost:3000).
   6b. DOMAIN: tell me the exact DNS record to add (A record: cloud9 → 65.21.181.247 on abiramnj.com, proxy OFF if it's on Cloudflare so WebSockets/TLS issuance work simply). Poll `dig +short cloud9.abiramnj.com` (every 30 s, up to 15 min) until it returns the server IP. Then, based on step 1:
     - If Nginx/Caddy/Traefik already owns 80/443: add a site for cloud9.abiramnj.com proxying to 127.0.0.1:3000 with WebSocket upgrade headers on /ws and a long read timeout (see docker/nginx.conf.example), get TLS the way that proxy already does it (e.g. certbot --nginx), validate (`nginx -t`) BEFORE reloading, and show me the diff first.
     - If 80/443 are free: `DOMAIN=cloud9.abiramnj.com docker compose --profile caddy up -d` (Caddy gets the certificate automatically).
     Then set PUBLIC_URL=https://cloud9.abiramnj.com in .env, confirm the app port mapping is still "127.0.0.1:3000:3000", and `docker compose up -d` to apply. Confirm https://cloud9.abiramnj.com/healthz works and that a newly created session's QR/join link uses the domain.
   If DNS still isn't resolving after 15 min, stop at 6a, finish the remaining steps on the IP, and give me the exact 6b commands to run later.
7. Verify from the outside (domain if 6b is done, else IP): the home page loads, `/healthz` ok, WebSocket works (log in at /mod, create a quiz via "Import CSV" using the template, start a session, open /join/<code> in a second browser/phone, play 2 questions). Then delete that test quiz.
8. Load test on the server itself, pointed directly at the app (not through the proxy): install Node 22 on the host if needed (or run it in a throwaway `node:22` container with --network host and the repo mounted), `npm ci`, then
   `npx tsx loadtest/bots.ts --url http://127.0.0.1:3000 --user admin --pass <admin-pass> --scenario C`
   while watching `docker stats` in parallel. Report the PASS/FAIL table plus peak CPU % and RAM of the cloud9 container AND confirm the other workloads stayed healthy.
9. Back up the DB once (command in README runbook) and add a nightly cron backup to /opt/cloud9/data/backups (keep 7).
10. Final report: URL(s), moderator credentials, how to view logs / restart / update (`git pull && docker compose up -d --build`), load test numbers, and anything I must do by hand (DNS, Hetzner firewall).

Safety: never run `docker system prune`, never remove volumes, never edit other apps' configs without showing me the change first, and ask before anything irreversible.
