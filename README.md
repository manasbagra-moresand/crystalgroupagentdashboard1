# Crystal Group Agent Dashboard

Live agent-availability dashboard for Crystal Group's contact centre team, backed by the
Zoom Phone API. Implements the design in
[`project/Crystal Group Agent Dashboard.dc.html`](./project/Crystal%20Group%20Agent%20Dashboard.dc.html)
(exported from Claude Design — see `chats/chat1.md` for the design conversation that shaped it).

Two screens behind an admin login:

- **Live Monitor** — KPI cards (Available / On Calls / Calls Waiting / Opted-In / Opted-Out /
  Online, No Queue / Abandoned Calls) plus every agent as a card, split into "Opted In /
  Active" and "Opted Out" sections.

  Note the two live-activity cards count on different bases, deliberately: **Available** is
  opted-in agents only (an opted-out agent isn't free to take a *queue* call), while **On
  Calls** counts the whole roster (an opted-out agent on a direct call is still on a call).

  Two mirror-image problems are called out:
  - **Abandoned** (red) — opted into a queue but not at their desk. The dashboard's main
    purpose.
  - **Over Break** (red) — past the time allowance for their opt-out reason. A countdown
    sits in front of every on-break agent's name, counting *down* from their allowance and
    then straight past zero into `+MM:SS`, because a break nine minutes over is exactly
    what a supervisor needs to see. Allowances are per reason (`BREAK_ALLOWANCES`):
    **Break 15 min, Meal 30 min**. The countdown ticks in the browser off an absolute end
    time, so it moves every second rather than every poll, and the row turns red the
    moment it crosses. Overrun rows sort above everything else in the section.

    ⚠️ Zoom's API doesn't say which reason an agent picked, so in practice every on-break
    agent is `Unspecified`, which is configured to the **longer 30-minute** allowance.
    That's a deliberate trade: assuming 15 would flag everyone genuinely at lunch as over
    at the 15-minute mark, and a wall of false red teaches people to ignore the colour.
    Erring long misses a short-break overrun instead. Until reasons come from a source
    that reports them, the 15-minute Break allowance only applies to agents whose custom
    Zoom presence status names a break.
  - **Online, No Queue** (orange) — at their desk and working, but opted out of *every*
    queue they belong to, so no queue call can reach them. Invisible otherwise: the row
    just reads "Available". These rows sort to the top of the Opted Out section, which
    runs to ~50 people, so highlighting alone would leave them below the fold. Not
    necessarily wrong — someone may be on admin work by arrangement — so it's presented as
    capacity to review, not an alarm (no pulse animation, unlike Abandoned).
- **Opt-In / Opt-Out Report** — pick a date and an agent (or "All agents"), see total time
  opted out, total login time, opted-in time, a per-reason breakdown (Zoom's four call-queue
  opt-out reasons — Break, Meal, Training, End Shift — plus Unspecified), and export it all
  to CSV.

## Architecture

```
src/                    Node + Express backend
  config.js             env config + the dashboard's own admin login (see Security note)
  zoom/
    s2sAuth.js           Zoom Server-to-Server OAuth token exchange (client secret stays here)
    client.js             Zoom Phone / presence / call-log API wrapper
  services/
    agentStatus.js         raw Zoom data -> agent state (Available/On Call/Waiting/On Break/Abandoned)
    poller.js               the one loop that actually calls Zoom; caches a snapshot for all requests
    optOutTracker.js         turns live status into today's opt-out event history
    eventStore.js             tiny JSON-file store backing the tracker (data/events.json)
    report.js                  reads the event store into the report tab's shape
  auth/session.js         cookie-session admin login gate
  routes/                  /api/auth, /api/dashboard, /api/report
  index.js                 app entrypoint

public/                 Plain HTML/CSS/JS frontend, pixel-matched to the .dc.html design
  index.html, css/styles.css
  js/api.js, js/liveMonitor.js, js/report.js, js/app.js
```

The frontend never talks to Zoom directly and never sees any credential — it only calls this
app's own `/api/*` endpoints. The backend is the only thing holding the Zoom Client Secret and
making Zoom API calls, on a single poll loop (default every 5s) that every browser tab shares.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the Zoom values below
npm start               # http://localhost:3000
```

### Zoom app

Create a **Server-to-Server OAuth** app in the
[Zoom App Marketplace](https://marketplace.zoom.us/) (Develop → Build App) and grant it the
these scopes:

| Scope | Needed for |
|---|---|
| `phone:read:list_users:admin` | the agent roster |
| `phone:read:list_call_queues:admin` | queue discovery |
| `phone:read:call_queue_member:admin` | per-queue opt-in/opt-out status |
| `user:read:presence_status:admin` | Available / Away / On Call presence |
| `phone:read:list_call_logs:admin` | calls taken/missed (optional — see below) |

Put the app's Account ID / Client ID / Client Secret into `.env`.

Two things that cost time if you don't know them:

- **Re-activate the app after editing scopes.** An S2S app that's been changed but not
  re-activated keeps issuing tokens with the old scopes.
- **Restart this server after granting scopes.** `zoom/s2sAuth.js` caches the access token
  until a minute before it expires (~1h), so a freshly-scoped app won't take effect on a
  running process.

Zoom renames granular scope IDs from time to time, and the error body names the scope it
actually wanted — `phone:read:call_log:admin`, for instance, is now
`phone:read:list_call_logs:admin`. Without the call-log scope the dashboard still runs: agent
state, opt-in/opt-out and the abandoned alert are all live, and only the per-agent
taken/missed counts read zero, with a warning saying so in the snapshot.

### Environment variables

See `.env.example` for the full list (`ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`,
`ZOOM_CLIENT_SECRET`, `SESSION_SECRET`, `POLL_INTERVAL_MS`, `TIME_ZONE`, `PORT`). `.env` is
gitignored.

### Time zone

Every date and time the dashboard records or displays is UK wall-clock time — BST in summer,
GMT in winter — regardless of the server's own zone or the viewer's browser. That's what
`src/time.js` (server) and `public/js/time.js` (browser) are for; nothing else in the app
should call `getHours()` or `toISOString().slice(0, 10)` directly. The header clock shows the
current abbreviation next to the time so it's unambiguous which one is in force.

`TIME_ZONE` overrides it. Use a full IANA zone name (`Europe/London`), never a fixed offset —
`Intl` handles the March/October switches from the zone name, and a hardcoded `+01:00` would
silently go an hour wrong every winter. If you change it, note that `data/events.json` stores
bare `HH:MM` strings keyed by date, so history written under the old zone won't match what's
written after the change.

## Security note — the dashboard login

Per explicit instruction, the dashboard's own admin login is a single hardcoded
username/password (`crystaltravel` / `P@$$w0rd`) checked server-side in `src/config.js` — it
is never sent to the browser. **This is a weak, shared, plaintext credential that has already
been typed into a chat session and committed to source control; treat it as compromised.**
Before this runs anywhere beyond a local prototype:

1. Set `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` instead (the code already prefers the
   env vars if set) and pick a strong, unique password.
2. Consider swapping the whole thing for real per-user accounts or Zoom user OAuth if more
   than one admin needs access.

## Where the data model is an approximation

Zoom doesn't expose the dashboard's exact vocabulary directly, so a few things here are a
best-effort mapping that should be checked against your actual Zoom account/plan and adjusted
in the corresponding file if the field names or behaviour differ.

Verified against the live account (477 phone users, 188 call queues, 2,573 queue memberships):

- **Opt-in/opt-out is read per queue, not per user.** `GET /phone/users/{id}/call_queues`
  does not exist — Zoom 404s it. The real source is
  `GET /phone/call_queues/{queueId}/members`, whose `receive_call` boolean is the opt-in
  flag, joined back to the roster on the member's `id`. `agentStatus.loadQueueMembership`
  inverts that into a per-user view.
- **Poll cost is the design constraint.** `DEPARTMENTS` narrows the roster (73 in-scope
  users, 60 on queues, not 477) and a full queue sweep runs only every
  `QUEUE_DISCOVERY_MS`, so normal polls revisit just the ~32 queues holding those agents.

  Measured per-phase cost on the live account, at `ZOOM_CONCURRENCY=8`:

  | Phase | Cost | Refreshed |
  |---|---|---|
  | `listPhoneUsers` (477) | 3.9s | every `ROSTER_TTL_MS` (10 min) |
  | `listCallQueues` (188) | 0.8s | every `ROSTER_TTL_MS` |
  | queue members (32 in scope) | 3.6s | **every tick** — live opt-in/out |
  | presence (73) | 3.7s | **every tick** — live agent state |
  | call logs (60) | 10.3s | every `CALL_LOG_TTL_MS` (60s), spread across ticks |

  Only the two "every tick" rows are genuinely live, and they depend on nothing but the
  in-scope user ids, so they run **concurrently** — ~4s together rather than ~7s in
  sequence. Everything else is cached. That's what brings a tick from ~30s to ~5s.

  **`ZOOM_CONCURRENCY` is not the lever it looks like.** Measured: a 60-agent presence
  sweep takes 3.2s at concurrency 8, 5.8s at 16, 4.6s at 40 — no 429s, no speed-up. Zoom's
  own per-request latency is the ceiling, so raising it just adds burst pressure.

  Ticks are chained, never overlapping, and the loop **paces to** `POLL_INTERVAL_MS` rather
  than sleeping it after the work — otherwise a 5s setting with a 5.5s poll would refresh
  every 10.5s. The snapshot warns only if a poll takes more than *twice* the interval.

  ⚠️ **A 5s interval is roughly 110 Zoom requests every 5s (~21/sec, ~1.3M/day if left
  running around the clock).** No 429s were observed, but Zoom Phone enforces daily as well
  as per-second limits, and this is the setting most likely to exhaust an account's quota.
  If you see 429s or a daily cap, raise `POLL_INTERVAL_MS` (30s costs a sixth as much) or
  run the dashboard only during contact-centre hours. For genuinely real-time state without
  the polling bill, Zoom's `phone.*` webhooks push changes instead.

- **Agent state** (`src/services/agentStatus.js`, `STATE_BY_PRESENCE`) — derived from Zoom's
  presence status crossed with per-queue opt-in status. "Abandoned" = opted into a queue but
  presence says they're not at their desk. See the opt-out reason note below for where the
  "On Break" reason comes from.

  Values confirmed on this account: `Available`, `Offline`, `Away`, `In_A_Call`,
  `Out_of_Office`. **A presence value missing from the map is not a harmless no-op** — it
  falls through to "away", and "away" while opted into a queue is reported as Abandoned, so
  one missing key turns working agents into red alerts. This bit once already: Zoom returns
  `In_A_Call` for a phone call, the map only had `On_A_Call`, and every agent actually on a
  call showed as "opted in but away". Keys are now matched case-insensitively, the documented
  siblings (`On_A_Call`, `In_A_Meeting`, `In_Calendar_Event`, `Busy`, …) are mapped too, and
  any value the map doesn't know is **named in the dashboard's warnings** rather than
  silently becoming an alert.
- **Attended / abandoned / skipped** (`src/services/agentStatus.js`, `RESULT_TAKEN` /
  `RESULT_MISSED` / `RESULT_SKIPPED` / `RESULT_IGNORED`) — Zoom's call log `result` strings
  are matched **exactly**, never by substring. Substring matching is a trap here:
  `"No Answer"` contains `"answer"`, so an `includes('answer')` test reports every missed
  call as attended.

  Inbound `result` values seen on this account over three days (1,530 inbound calls):

  | Result | Count | Counted as |
  |---|---|---|
  | `Call connected` | 1078 | attended |
  | `Auto Recorded` | 227 | attended |
  | `Answered by Other Member` | 92 | **skipped** |
  | `No Answer` | 76 | abandoned |
  | `Call Cancel` | 30 | abandoned |
  | *(empty)* | 15 | ignored — nothing to infer |
  | `Busy` | 10 | abandoned |
  | `Call failed` | 2 | abandoned |

  **Skipped** is the call that rang this agent and a colleague answered instead. Those
  entries carry `duration: 0`, a non-zero `waiting_time` (seconds it rang them),
  `forwarded_by.extension_type: "callQueue"` and an `accepted_by` naming who took it. It's
  deliberately its own column rather than folded into either total: counting it attended
  would credit work they didn't do, counting it abandoned would punish everyone on a shared
  queue whenever a colleague was quicker. Skipping is normal on a shared queue, so the
  figure only starts colouring at 5+ and never uses the red reserved for abandoned calls.

  Any `result` the sets don't cover is counted by call duration as a fallback **and named
  in the dashboard's warnings**. That's not theoretical — it's how `Call failed` was found.

- **Calls Waiting** — not reliably derivable from the REST call log, and currently always 0.
  A call is only logged once it has already ended, so every entry carries a terminal result
  and there is no "ringing now" state to find. `isLikelyRinging` makes a narrow inference
  from very recent queue-forwarded entries with no duration. For real live queue depth you
  need the `phone.callee_ringing` webhook or Zoom Contact Center's real-time queue metrics.
- **Scope of the dashboard** — set `DEPARTMENTS` to the business unit(s) to cover. It's
  matched against each Zoom phone user's `department` **or** `cost_center`; Zoom phone users
  have no "group" field, and on the live account those two fields disagree for one person, so
  either matching counts. Matching is trimmed/case-insensitive but exact after that, so
  `Crystal UK` picks up the `Crystal Uk` and `Crystal UK ` typos without pulling in
  `Crystal US`. An in-scope user on no call queue is not treated as an agent.

- **Opt-out reasons** (`src/services/reasons.js`) — the vocabulary matches Zoom's own
  call-queue opt-out reasons exactly: **Break, Meal, Training, End Shift**. Keep it that way;
  the report buckets by these names.

  **The API does not expose which reason an agent picked.** The reason is visible in the Zoom
  admin dashboard, but it appears on no Phone endpoint this app can read — verified against
  the live account: `GET /phone/call_queues/{id}/members` returns only
  `id, name, level, receive_call, extension_id`, the queue detail endpoint embeds the same
  member shape, and there is no opt-out-reason endpoint (`/contact_center/*` returns 401 on
  this plan). So the report attributes a period only when it can:

  | Reason | Where it comes from |
  |---|---|
  | `End Shift` | Observed. An agent's presence going `Offline` *is* the end of their shift. |
  | `Break` / `Meal` / `Training` | Inferred, and only if the agent has typed a free-text custom presence status (`REASON_SYNONYMS` in `agentStatus.js` matches it on whole words). **Nobody on this account sets one**, so in practice these stay at zero. |
  | `Unspecified` | Everything else — an agent opted out while still online, with nothing to attribute it to. Deliberately not folded into a real Zoom reason: a gap in the data shouldn't read as a confident number. |

  If you need the real per-reason split, it has to come from somewhere the API actually
  publishes it — the Zoom admin dashboard's own report/export, or a `phone.*` webhook that
  carries the reason on the opt-out event. Until then, expect the breakdown to be mostly
  `End Shift` and `Unspecified`.

- **Opt-out history** (`src/services/optOutTracker.js`) — Zoom doesn't provide a ready-made
  "give me every opt-out period for this agent today" endpoint, so the backend builds it
  itself by polling live status and recording transitions to `data/events.json`. This means
  history only exists from when the server started polling — it isn't backfilled from Zoom.
- **Login/logout times** — the first and most recent poll tick where an agent's presence
  wasn't `Offline`, not a dedicated Zoom "shift" record.

None of this needed to be exact to implement the design faithfully, but it's the first place
to look if live numbers don't match what you expect once this runs against a real account.

## Design source

- `project/Crystal Group Agent Dashboard.v2.dc.html` — **the current design.** The visual
  language in `public/` follows this one: the saturated state palette (its `TONE` map), the
  KPI row as a single hairline-divided panel rather than separate cards, agent state as
  plain coloured mono text rather than a pill, opted-out queues as chips behind
  "Out of" / "In all queues", `1.5px` red border plus "Abandoned call" wording instead of an
  alert footer, and `minmax(212px)` grids throughout.
- `project/Crystal Group Agent Dashboard.dc.html` — the earlier revision the app was
  originally built from. Kept for diffing; superseded by v2.
- `project/support.js` — the canvas runtime both prototypes reference. Not used here.
- `chats/chat1.md` — the design conversation the prototype was built from.

**Where the implementation deliberately goes beyond the design.** v2 specifies five KPIs and
no per-agent call breakdown. The app keeps the features added since: the On calls / Online,
no queue / Over break KPI cells, the skipped-call figure, and the break countdown in front
of on-break agents' names. Each is styled in the design's own idiom (dot + label in the KPI
bar, mono figures on the cards) rather than bolted on, so re-syncing the design should mean
matching those conventions, not deleting the features.
