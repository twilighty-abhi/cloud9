# Cloud9 audit and verification

The audit started from Cloud9 commit `27066a6`. Players still join without an account, presenters can view rooms without signing in, and moderator permissions retain the existing ownership and super-moderator rules. An email still groups scores across an event. A player needs the original browser token to resume a specific entry.

## Findings and fixes

| ID | Finding | Fix and verification |
| --- | --- | --- |
| C9-01 | A typed email could mint a token for another player, including after joins closed. | Resume uses the existing token. Duplicate emails return a conflict in open rooms. The HTTP and WebSocket regression cases cover both identities. |
| C9-02 | Production started with default or empty moderator settings. The sample signing secret was also accepted. | Require explicit moderator accounts and a signing secret of at least 32 characters in production. Startup regressions cover missing and empty accounts. |
| C9-03 | Public event scores exposed correctness before reveal. | Public HTTP and realtime event boards exclude unrevealed points across sessions. Test that the same points appear after reveal. |
| C9-04 | Score writes could survive a failed answer write. | Commit the answer and score together before acknowledgment. The fault-injection test forces an answer write to fail, restarts the app, and checks both records. |
| C9-05 | Direct callers could spoof IPs to evade rate limits. | Trust forwarded IPs only from a configured immediate proxy. Test direct spoofing and local Caddy forwarding. |
| C9-06 | Malformed CSV quoting could save a quiz. | Reject quote errors and return a row-level message before persistence. |
| C9-07 | Newer unrelated sessions could crowd older entries out of an event’s history. | Filter SQLite session history by event before applying the existing 100-row limit. Test with 100 newer unrelated rows. |
| C9-08 | Copied cookies and existing moderator sockets survived logout. | Persist signed session IDs in SQLite, revoke them at logout, and disconnect their moderator sockets. Test HTTP replay and a command sent on the old socket. |
| C9-09 | Foreign-origin WebSockets accepted moderator cookies. | Reject browser origins outside the configured public origin. Local development also accepts the default Vite origins. |
| C9-10 | Finished results disappeared after restart. | Restore finished results for the existing six-hour retention window. Test reconnect with the original player token. |
| C9-11 | Invalid percent encoding during browser navigation threw an uncaught error. | Handle invalid encoding in route matching and render the existing invalid-room page. |
| C9-12 | Production URLs could activate a fake moderator dashboard. | Enable fixture mode only in development. Test that the production URL requires sign-in. |
| C9-13 | An event email-policy change failed to update active rooms. | Refresh the policy for new joins in those rooms. Already-joined players retain their entries. |
| C9-14 | Unknown assets and the bare API prefix returned the SPA with HTTP 200. | Limit fallback to UI routes and return 404 for missing assets and API paths. |
| C9-15 | Load-test output serialized the moderator password. | Use an allowlist of report fields. Inspect generated JSON for credential fields and the disposable password. |
| C9-16 | Hashed assets received `max-age=0`. | Use immutable caching for built assets and revalidation for HTML. Test both headers. |

The dependency upgrade resolved the four reported packages in the local npm audit. The advisories described affected versions. Their exploitability through Cloud9’s enabled routes was not established. [Fastify Static](https://github.com/advisories/GHSA-83w8-p2f5-377r) · [Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) · [glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) · [minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249)

## Reproduce the checks

```sh
npm ci
npm run typecheck
npm test
npx playwright install chromium webkit
npm run test:browser
npm audit
npm audit --omit=dev
```

- Server coverage includes anonymous access, owner and super-moderator boundaries, secure cookie attributes, room QR and CSV headers, login and join limits, quiz and event CRUD, import validation, formula escaping, scoring, role-specific WebSocket snapshots, malformed and oversized frames, kicking, replay, restart, SQLite migration, and persisted results.
- Browser coverage runs a two-question event with a moderator, a mobile player, and a projector. It checks listing, join, mid-question refresh, answer reveal, standings, finishing, and CSV download. Chromium and WebKit run locally with mobile viewport presets.
- The production Docker image uses Node 22. The local Compose check covers Caddy HTTPS with a local certificate, the Secure cookie, a WSS moderator connection, and forwarded-header spoof rejection. The Nginx example passes its syntax check.

## Load verification

The local Node 22 Docker run used 250 players and ten questions per scenario, with real HTTP, WebSockets, and a file-backed SQLite database.

| Scenario | Room layout | Answer acknowledgment p95 | Broadcast p95 | Peak server RSS |
| --- | --- | --- | --- | --- |
| A | 1 × 250 players | 13.6 ms | 31.1 ms | 134 MB |
| B | 5 × 50 players | 6.8 ms | 10.0 ms | 137 MB |
| C | 5 × 50 players with reconnect churn and a shared event | 6.2 ms | 12.0 ms | 144 MB |

All 7,500 answers were acknowledged. Scenario C recorded 514 disconnects and 514 reconnects with zero score drift. All three generated reports omitted moderator credentials.

## Remaining deployment checks

- Verify the deployed domain, certificate renewal, WebSocket upgrades, forwarding headers, and loopback-only app binding. For a host proxy, confirm the actual peer IP seen by Cloud9 before setting `TRUSTED_PROXY`.
- Scan a real QR on Android and iOS over venue Wi-Fi and mobile data. Check sleep, airplane mode, network switching, projector readability, keyboard navigation, and screen-reader operation.
- Repeat the load scenarios on the target VPS and venue network. Watch CPU, memory, disk latency, the event-board refresh rate, and throttling when many participants share one IP.
- Restore a production-shaped backup to an isolated copy and compare stored answers, scores, rankings, and CSVs. The transaction protects future writes. Historical data from an earlier failed write may need reconciliation.
- Keep event scores based on self-reported email as designed. Where standings determine prizes, check attendee identities before awarding them. Public room codes and projector links are shareable, including unlisted rooms reached by code.
- Check server and proxy logs, backups, and old load reports for private data. Rotate any real moderator password previously shared in a report.
