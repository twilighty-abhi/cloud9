# Cloud 9 Telegram bot

Cloud 9 can post quiz activity to Telegram and answer a few commands, so the organisers can follow every hall from their phones.
It is **off unless `TELEGRAM_BOT_TOKEN` is set**. When Telegram is slow or down, the quiz is not affected: messages wait in an
outbox (in the same SQLite file) and are sent once Telegram is reachable again.

- [1. Create the bot](#1-create-the-bot)
- [2. Find the ids](#2-find-the-ids)
- [3. Configure](#3-configure)
- [4. What gets sent where](#4-what-gets-sent-where)
- [5. Commands and buttons](#5-commands-and-buttons)
- [6. Actions (create, joining, hide, end)](#6-actions-create-joining-hide-end)
- [7. Privacy](#7-privacy)
- [8. Troubleshooting](#8-troubleshooting)
- [9. Turning it off](#9-turning-it-off)

---

## 1. Create the bot

1. In Telegram, open **@BotFather** and send `/newbot`. Pick a display name (e.g. *Cloud 9 Crew*) and a username ending in `bot`
   (e.g. `cloud9_crew_bot`).
2. BotFather replies with a token like `7412345678:AAH…`. This is `TELEGRAM_BOT_TOKEN`. Treat it like a password.
3. *(Groups only)* Privacy mode can stay **on** (the default). With privacy on, a bot in a group only receives `/commands`,
   and commands are all Cloud 9 needs. If you want to check: `/setprivacy` → pick the bot → **Enable**.
4. *(Optional)* `/setjoingroups` → **Disable** after you've added the bot to your group, so nobody else can add it to theirs.

Cloud 9 registers its command menu itself at boot (`setMyCommands`), so you don't need `/setcommands`.

## 2. Find the ids

You need **user ids** for the admins and **chat ids** for where notifications go.

### Your user id (for `TELEGRAM_ADMIN_IDS`)

Message **@userinfobot** (any message). It replies with `Id: 123456789`. Each admin does this and sends you their number.

The user id of a person is also the chat id of that person's private chat with the bot. To receive notifications privately,
open the bot and press **Start** first: bots can't message someone who never started them.

### A group's chat id (for `TELEGRAM_NOTIFY_CHAT_IDS`)

Group chat ids are negative. Supergroups (all groups with topics) look like `-1001234567890`.

**Option A: from a message link (easiest).** In a supergroup, long-press any message → **Copy Message Link**. You get
`https://t.me/c/1234567890/345`. The chat id is `-100` followed by the number after `/c/`: `-1001234567890`.

**Option B: `getUpdates`.** Add the bot to the group, send `/start@your_bot` in the group, then run:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":-[0-9]*'
```

> Do this **before** you set the token on the server. Cloud 9 also polls `getUpdates`; once it runs, it consumes the updates
> and your curl returns nothing or `409 Conflict`. If the server is already running, use option A, or stop the app for a minute.

### Forum topics (optional, for `TELEGRAM_TOPICS`)

If the group has **Topics** turned on (Group settings → Topics), Cloud 9 can post each hall into its own topic.

1. Create one topic per moderator (e.g. *Hall 1*, *Hall 2*), plus *Admin* and *System* if you like.
2. Send a message in the topic, long-press → **Copy Message Link**: `https://t.me/c/1234567890/12/345`.
   The format is `t.me/c/<chat>/<topic>/<message>`, so the **topic id is 12**.
   (A link with only two numbers, `t.me/c/<chat>/<message>`, is in *General*, which has no topic id.)
3. Map topics to **moderator usernames** (the names in `MODERATORS`), plus `system` and `admin`:
   `TELEGRAM_TOPICS=hall1=12,hall2=13,hall3=14,admin=15,system=16`.

Lookup per message: the moderator's topic → else the `admin` topic → else *General*. `system` is for boot and warning
messages. Topics only apply to group chats; private chats ignore them.

Make the bot a member of the group. It does **not** need to be an admin, but in groups where only admins may post (or with
closed topics) it needs permission to send messages.

## 3. Configure

Add to `.env` (see the commented block in `.env.example`), then `docker compose up -d` (not just `restart`).

| Variable | Default | Example | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *(unset = off)* | `7412345678:AAH…` | Bot token from BotFather. Setting it turns the feature on. |
| `TELEGRAM_NOTIFY_CHAT_IDS` | *(none)* | `-1001234567890,123456789` | Where notifications go: group ids and/or admins' user ids (private chats), comma-separated. |
| `TELEGRAM_ADMIN_IDS` | *(none)* | `123456789,987654321` | Telegram **user** ids allowed to use commands and buttons. Everyone else is ignored. |
| `TELEGRAM_TOPICS` | *(none)* | `hall1=12,hall2=13,admin=15,system=16` | Forum topic id per moderator username, plus `admin` (fallback) and `system`. |
| `TELEGRAM_DIGEST_MINUTES` | `30` | `0` | Event leaderboard digest every N minutes while a session of that event is live. `0` = off. |
| `TELEGRAM_NOTIFY_QUESTIONS` | `0` | `1` | One line per closed question (answered / correct counts). Noisy with several halls. |
| `TELEGRAM_SEND_CSV` | `1` | `0` | Send the results CSV when a session finishes (admin private chats only, see §7). |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | — | Only for tests (points at a fake API). Leave unset. |

A typical event setup:

```bash
TELEGRAM_BOT_TOKEN=7412345678:AAH...
TELEGRAM_NOTIFY_CHAT_IDS=-1001234567890,123456789     # crew group + the lead organiser's private chat
TELEGRAM_ADMIN_IDS=123456789,987654321                # people who may run commands
TELEGRAM_TOPICS=hall1=12,hall2=13,hall3=14,admin=15,system=16
```

Check it worked: within a few seconds of boot the *System* topic (or *General*) gets **"✅ Cloud 9 online"**, and in a
private chat with the bot `/stats` answers.

## 4. What gets sent where

Every message goes to **every** chat in `TELEGRAM_NOTIFY_CHAT_IDS`; in groups it lands in the topic for that moderator.

| When | Message | Topic |
|---|---|---|
| Server boots | "Cloud 9 online · N rooms restored" | `system` |
| Server warning | ⚠️ short text | `system` |
| Event created / edited / deleted | Event name, email required/optional, who did it | the moderator who did it |
| Quiz created / edited / deleted | Title, question count, event | quiz owner |
| Session created | Quiz, label, code, moderator, event, buttons **Details** / **Board** | session's moderator |
| Session settings changed | What changed (label, listed, joining open/closed) | session's moderator |
| Session started | Quiz, label, player count | session's moderator |
| Question closed *(only with `TELEGRAM_NOTIFY_QUESTIONS=1`)* | Q n: answered / correct | session's moderator |
| Player kicked | Player name | session's moderator |
| Session finished | Quiz top 10 + event standings, buttons **Quiz board** / **Event board** | session's moderator |
| Session finished *(`TELEGRAM_SEND_CSV=1`)* | Results CSV file | sent privately to **every user in `TELEGRAM_ADMIN_IDS`**, never to groups |
| Digest *(every `TELEGRAM_DIGEST_MINUTES` while live)* | Event top 10 and live sessions | `admin` |

Telegram limits bots to about 20 messages per minute per group. Cloud 9 paces itself, merges repeated updates for the same
session, and drops low-priority messages (digests, question lines) first if it falls behind. Messages older than 24 h are
dropped instead of being sent late.

## 5. Commands and buttons

Only users in `TELEGRAM_ADMIN_IDS` can use these. They work in a private chat with the bot and in groups
(`/live` or `/live@your_bot`). Codes can be typed as `123456` or `123 456`.

| Command | What it does |
|---|---|
| `/live` | Live sessions right now: hall, state (Lobby / Q3 of 10 …), players |
| `/events` | All events with quiz and session counts |
| `/event [name]` | Event run sheet: quizzes, sessions, top 5 |
| `/leaderboard [code \| event name]` | Quiz leaderboard for a session, or an event's standings |
| `/winner [event name]` | Event #1 (with email in a private chat) |
| `/session <code>` | Session details |
| `/quizzes [event name]` | Quizzes of an event |
| `/export <code>` · `/export event [name]` | CSV file. **Private chat only.** |
| `/stats` | Server health and outbox stats (queued / sent / failed, last error) |
| `/help` | The list above |

Buttons under messages do the same: **Board** / **Quiz board** (session leaderboard), **Event board**, **Details**, and
**⬇️ CSV** (shown in private chats only).

Anyone not in `TELEGRAM_ADMIN_IDS` gets "This bot is private." in a private chat (at most once an hour) and silence in groups.

## 6. Actions (create, joining, hide, end)

Admins can also **change** a few things from Telegram, so a hall can be set up or wrapped up without a laptop. Same rule as
the commands: only users in `TELEGRAM_ADMIN_IDS`; everyone else is ignored (or told "This bot is private.").

| Command | What it does |
|---|---|
| `/newsession [text]` | Create a session **lobby** for a quiz. Shows the quizzes of the current event as buttons (add text to filter by title; if only one quiz matches, it goes straight to the confirm step). |
| `/joining <code> on` · `/joining <code> off` | Open or close joining. Players already in the room stay in. |
| `/hide <code>` · `/show <code>` | Hide the session from the home page, or show it again. With the code, players can still join a hidden session. |
| `/end <code>` | End the session now. The final leaderboard is posted and the CSV goes to the admins, the same as when the moderator ends it. |

**What you can't do from Telegram:** start the quiz, close or reveal a question, or go to the next question. Those stay on
the **moderator screen**, where the person running the hall can see the room.

### Every change needs a confirm tap

Nothing changes when you send the command. The bot replies with what will happen and two buttons, **✅ Yes** (or
**✅ Create**) and **✖ Cancel**. Only the tap does it.

- **✖ Cancel** changes the message to "Cancelled." and does nothing.
- Confirm buttons **expire after 10 minutes**, and after a server restart. An old button answers "This button expired — run
  the command again."
- Each confirm works **once**. Tapping **✅ Create** again answers "Already live: code …" instead of making a second lobby.
  `/newsession` also warns when the quiz already has a live session.
- Buttons under a session message (**Close joining**, **End**) take you to the same confirm step.

### Who owns a session created from Telegram

The **hall account that owns the quiz** owns the lobby (for example `hall1`), not the admin who tapped. So it shows up in
that moderator's dashboard, they run it from their screen as usual, and its notifications go to that hall's topic. The
notification says who created it (`by telegram:<your user id>`).

The **label** comes from the quiz title when it starts with the hall and a time: a quiz titled
`Hall 1 · 2:40–3:10 PM · When AI Gets a Body · Sarath` gets the label **Hall 1 · 2:40 PM**. Other titles get no label. The
session is listed on the home page.

The reply has the code, the **join link** (`/join/<code>`), the **projector link** (`/present/<code>`), the **moderator
link** (`/mod/room/<code>`), and a **QR code** image to put on screen or forward to the hall.

### Example

```text
you:  /newsession when ai
bot:  Create a lobby for Hall 1 · 2:40–3:10 PM · When AI Gets a Body · Sarath?
      Owner: hall1 · Label: Hall 1 · 2:40 PM · Players can join as soon as it's created.
      [✅ Create] [✖ Cancel]
you:  (tap ✅ Create)
bot:  Done ✓ Lobby created … Code: 924 828 · Join: https://quiz.example.org/join/924828 …   + QR image

you:  /joining 924828 off
bot:  Close joining for Hall 1 · 2:40–3:10 PM · When AI Gets a Body · Sarath (Hall 1 · 2:40 PM)? 42 players are in.   [✅ Yes] [✖ Cancel]
you:  (tap ✅ Yes)
bot:  Done ✓ …

you:  /end 924 828
bot:  End Hall 1 · 2:40–3:10 PM · When AI Gets a Body · Sarath (Hall 1 · 2:40 PM) now? … The final leaderboard will be posted.   [✅ Yes] [✖ Cancel]
```

The actions work in a private chat with the bot and in the group. In the group, everyone in the chat sees the confirm
message, but only admins' taps count.

## 7. Privacy

- **Groups never see emails.** Notifications and group command replies show player names and scores only. Even a name that
  looks like an email is masked.
- **Emails appear only in admin private chats** (`/winner`, `/leaderboard`, `/session` in a private chat with the bot).
- **CSV files contain emails** and go **only to admins' private chats**: on session finish (to every user id in
  `TELEGRAM_ADMIN_IDS`, whether or not it is in `TELEGRAM_NOTIFY_CHAT_IDS`) and via `/export` / **⬇️ CSV**. Asking for one in a group gets "Ask me in a private chat".
- The bot's log lines don't include player emails (the e2e test checks this).
- Telegram keeps messages on its servers. After the event, delete CSVs from chats if your data policy needs it.

## 8. Troubleshooting

Logs: `docker compose logs -f app | grep -i telegram`. In a private chat, `/stats` shows the outbox and the last error.

| Symptom | Cause / fix |
|---|---|
| Nothing at all, no "online" message | `TELEGRAM_BOT_TOKEN` not set in `.env`, or you ran `restart` instead of `docker compose up -d`. A wrong token logs `401 Unauthorized`. |
| `409 Conflict` in the logs | Something else reads the same bot: a second Cloud 9 instance (staging, your laptop running `npm run dev:server`), your own `curl getUpdates` loop, or a webhook. Stop the other one. Cloud 9 deletes webhooks at boot and backs off 30 s on 409. Notifications still go out; only commands are affected. |
| `403 Forbidden: bot is not a member` / `chat not found` | The bot isn't in that group (or was removed), or the id is wrong (supergroup ids start with `-100`). Add the bot and check the id (§2). These messages are marked failed, not retried. |
| `403: bot can't initiate conversation with a user` | That admin never pressed **Start** in the bot's private chat. Open the bot, press Start. |
| Messages land in *General* instead of the hall topic | Username in `TELEGRAM_TOPICS` doesn't match `MODERATORS` (lowercase), or no topic set for that moderator (falls back to `admin`, then *General*). |
| Log says `topic N not found — sending without thread` | The topic was deleted or the id is wrong. Cloud 9 sends to *General* instead so nothing is lost; fix the id. |
| Commands ignored in the group | Your user id isn't in `TELEGRAM_ADMIN_IDS` (groups get no reply for non-admins). Check with @userinfobot. If several bots are in the group, use `/live@your_bot`. |
| "This bot is private." | Same: your user id isn't in `TELEGRAM_ADMIN_IDS`. |
| Messages arrive late during a busy finish | Normal pacing (≈20/min per group). Several halls finishing together may take a minute. |
| `429 Too Many Requests` in logs | Telegram rate limit; Cloud 9 waits the time Telegram asks for and continues. |
| Telegram down / server offline | The quiz keeps running. Messages stay in the outbox and are sent when it's back (up to 24 h old). |

## 9. Turning it off

Remove or comment out `TELEGRAM_BOT_TOKEN` in `.env`, then `docker compose up -d`. With no token the server makes no
Telegram calls at all. The other `TELEGRAM_*` variables can stay.

To mute only some parts: `TELEGRAM_DIGEST_MINUTES=0`, `TELEGRAM_NOTIFY_QUESTIONS=0`, `TELEGRAM_SEND_CSV=0`, or remove a chat
from `TELEGRAM_NOTIFY_CHAT_IDS` (commands from admins keep working).

To kill the bot for good (for example if the token leaked): BotFather → `/revoke` → pick the bot. Then set the new token or
remove it.

## For developers

`npm test` includes `server/test/telegram-e2e.test.ts`. It runs the real server against a fake Bot API
(`server/test/fakeTelegram.ts`), plays a 3-player game and checks routing, privacy, commands, buttons, the token-unset case
and outbox delivery after an outage. A separate test drives the admin actions (`/newsession`, `/joining`, `/hide`, `/show`,
`/end`, confirm taps, expired and repeated buttons, non-admins) and checks the result through the HTTP API. `TG_E2E_WAIT_MS` changes how long each Telegram expectation waits (default 12000).
