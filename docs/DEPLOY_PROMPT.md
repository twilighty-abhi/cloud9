Deploy "Cloud 9" (a live quiz web app) to my server over SSH and get it production-ready for an event TOMORROW (~200 concurrent players). Work carefully: this server already runs other workloads that must NOT be disturbed.

Server: <SSH_TARGET e.g. root@1.2.3.4>  (Hetzner, 4 GB RAM, 2 vCPU, ~1 GB already used)
Repo: git@github.com:twilighty-abhi/cloud9.git (PRIVATE)
Domain: <DOMAIN or "none yet — use the IP for now">
Moderator accounts I want: <e.g. admin (super), mod1, mod2, mod3>

Read README.md and docs/PLAN.md in the repo first; README has the deploy steps and the event-day runbook.

Steps:
1. Recon (read-only first): OS, `docker --version`, `docker compose version`, free RAM/disk, `docker ps` (list what's already running), and what is listening on 80/443/3000 (`ss -ltnp`). Tell me what you found before changing anything. Do NOT stop, restart, or modify any existing container, service, or proxy config without asking me.
2. Install Docker + compose plugin only if missing.
3. Clone to /opt/cloud9. The repo is private: create a read-only deploy key on the server (`ssh-keygen -t ed25519 -f ~/.ssh/cloud9_deploy -N ""`), show me the public key and wait for me to add it at GitHub → repo → Settings → Deploy keys, then clone using that key (GIT_SSH_COMMAND or ~/.ssh/config Host alias).
4. Create /opt/cloud9/.env from .env.example:
   - PUBLIC_URL = https://<DOMAIN> (or http://<server-ip>:3000 if no domain yet)
   - SESSION_SECRET = `openssl rand -hex 32`
   - MODERATORS = the accounts above with strong random passwords (format admin:PASS:super,mod1:PASS,...)
   - JOIN_RATE_PER_MIN=1000, LOGIN_RATE_PER_MIN=20 (venue Wi-Fi shares one IP)
   - chmod 600 .env. Print the moderator usernames + passwords to me ONCE at the end.
5. `mkdir -p data && chown 1000:1000 data` (container runs as uid 1000), then `docker compose up -d --build`. Check `docker compose ps` is healthy and `curl -s localhost:3000/healthz` returns ok.
6. Expose it, choosing based on step 1:
   - If Nginx/Caddy/Traefik already owns 80/443: add a site for <DOMAIN> proxying to 127.0.0.1:3000 with WebSocket upgrade headers on /ws and a long read timeout (see docker/nginx.conf.example), validate config (`nginx -t`) BEFORE reloading, and get TLS the way that proxy already does it. Show me the diff before reloading.
   - If 80/443 are free and DNS for <DOMAIN> points here: `DOMAIN=<DOMAIN> docker compose --profile caddy up -d`.
   - If no domain yet: change the app port mapping to "3000:3000" temporarily and open 3000 in the firewall (ufw / Hetzner firewall — tell me if the Hetzner cloud firewall needs a manual change).
7. Verify from the outside: the home page loads, `/healthz` ok, WebSocket works (log in at /mod, create a quiz via "Import CSV" using the template, start a session, open /join/<code> in a second browser/phone, play 2 questions). Then delete that test quiz.
8. Load test on the server itself, pointed directly at the app (not through the proxy): install Node 22 on the host if needed (or run it in a throwaway `node:22` container with --network host and the repo mounted), `npm ci`, then
   `npx tsx loadtest/bots.ts --url http://127.0.0.1:3000 --user admin --pass <admin-pass> --scenario C`
   while watching `docker stats` in parallel. Report the PASS/FAIL table plus peak CPU % and RAM of the cloud9 container AND confirm the other workloads stayed healthy.
9. Back up the DB once (command in README runbook) and add a nightly cron backup to /opt/cloud9/data/backups (keep 7).
10. Final report: URL(s), moderator credentials, how to view logs / restart / update (`git pull && docker compose up -d --build`), load test numbers, and anything I must do by hand (DNS, Hetzner firewall, deploy key).

Safety: never run `docker system prune`, never remove volumes, never edit other apps' configs without showing me the change first, and ask before anything irreversible.
