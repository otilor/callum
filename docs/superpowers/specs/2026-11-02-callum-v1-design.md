# Callum v1 — build spec

Date: 2026-11-02. Source of truth for product behavior: `docs/design/v2-journey.md` (the v2 design doc) and the six boards in `docs/design/boards/`. This spec turns them into a buildable app and records every decision the design leaves open.

## What we're building

Callum is a single-user, open-source outreach **desktop app (Electron)**. It reaches people by email, LinkedIn and X on its own, within safe limits, and hands the user only the people who reply. The user installs it on their own computer; it keeps working from the tray with its window closed. A second way to run it is server mode (`npm start` on a small server with a password, opened from a browser or phone).

The unit of Callum is a **person**, not a message or campaign.

## Product rules (binding)

### Stages and statuses
- Stages, left to right: `stranger` (no touch yet), `hello` (1 touch sent), `following` (2 or 3 touches sent), `talking` (they replied and the user answered).
- The **dock** holds people who replied and are waiting on the user (status `waiting`). Sun yellow `#FFB020` is used only for them and for Callum's voice.
- Exits: after 3 unanswered touches a person **rests for 90 days**, then becomes a stranger again. Anyone who says stop is **stopped forever**.
- One person, one conversation: one channel per person, and never two channels in the same 7 days.

### Touches and timing
- Up to 3 touches per person over about two weeks: touch 1 (hello) at the first sending slot; touch 2 (follow-up) 4 days later; touch 3 (last follow-up) 6 days after touch 2; 4 days after touch 3 with no reply, the person rests.
- LinkedIn path: touch 1 = connection invite with a note of at most 280 characters; when accepted, touch 2 = thank-you message at the next 11:00 recipient-local weekday after the acceptance is seen; touch 3 = follow-up 5 days after the thank-you. An invite not accepted within 14 days → rest.
- Sending hours: 9:00–17:00, Monday–Friday, in the recipient's time zone (default: the user's time zone). Public holidays are not modeled in v1.
- Nothing goes out on the day the user presses Start. The first sends happen at the next sending slot from 9:00 the next weekday.

### Pace (per day, counted in the user's time zone)
- Email per mailbox: days 0–6 after connecting → 20; days 7–13 → 70; day 14 on → 120 ("20 a day now, 120 by week 3").
- LinkedIn: 15 invites a day; 7 a day for 7 days after a verification check if the user resumes at half pace; 40 messages a day; if LinkedIn reports the weekly invite limit, no invites until next Monday 00:00 in the user's time zone.
- X: 20 DMs a day.
- No volume dial past these limits.

### Control
- The user OKs the first 10 hellos (Day one). After 10 OKs, Callum sends on its own. "Don't contact" on a hello stops that person and does not use up an OK; the next stranger's hello takes its place.
- Callum drafts replies; the user sends them. Callum never auto-replies to a person who wrote back.
- Every user-triggered send waits at least 10 seconds before leaving, with Undo. Auto sends are scheduled for their slot and can be cancelled until they leave.
- Placeholder guard: never send any text containing a bracket placeholder like `[YOUR PRICE]`, `{{first_name}}` or `{first_name}`. The send is refused with the placeholder named.
- Every email carries a one-line opt-out ("If this isn't for you, just reply stop and I won't write again.") and a `List-Unsubscribe: <mailto:sender?subject=stop>` header.
- No open tracking, ever.
- People you know: on import, skip anyone already stopped or already in Callum, and (when email is connected) anyone in the mailbox's Sent folder.

### Replies
Every inbound message is classified as one of: `interested`, `question`, `not_now`, `not_interested`, `stop`, `hostile`, `out_of_office`, `referral`.
- `stop` → stopped forever, all pending messages cancelled, kept off the dock.
- `hostile` → status `closed`, all pending cancelled, nothing sent, kept off the dock. (Ruling: the design says "Callum closes politely"; sending anything to a hostile person automatically is riskier than silence.)
- `out_of_office` → not a reply. If a return date is found, the next touch moves to the first slot after it.
- `referral` → the referrer goes to the dock like any reply, and the referred person is added as a new stranger with `source: 'referral'` and the context in `note`.
- everything else → dock (`waiting`), pending auto touches cancelled, a reply draft is written in the language of the inbound message, and a suggested action is set (`reply`, `book`, `snooze` or `close`).
- A reply on another channel merges into the same person (match by email, LinkedIn URL or X handle).
- If the user replies themselves from their mailbox (seen in Sent), Callum stops follow-ups and marks the person `talking`.

### Dock actions
- **Reply** (edited draft) → send with 10 s Undo; person becomes `talking` with badge `sent`.
- **Book a call** → sends a short message with the user's calendar link; badge `booked`. Refused with "Add your calendar link first" if none is set.
- **Snooze** → back on the dock at the chosen time (default: next Monday 9:00, user time zone).
- **Close politely** → sends a short polite close; status `closed`.
- Corrections: "That's an auto-reply" (back into the river, next touch rescheduled), "Wrong person" (removed), "Never contact" (stopped).

### Face actions
- **Nudge now** → next touch due now (still inside sending hours and pace).
- **Hold** → nothing goes to them until **Resume**.

### Something breaks
Errors stop the affected channel first, then explain. Each incident has a message in the design's words (see `v2-journey.md` §6 Errors):
- LinkedIn verification check → LinkedIn paused, email and X keep going. User finishes the check, then resumes at half pace (recommended) or full pace.
- LinkedIn weekly invite limit → invites wait until Monday; messages keep going.
- Mailbox signed out → email paused, queued emails kept, Reconnect resolves it.
- Bounces → address removed; the person moves to LinkedIn, else X, else is removed. One incident per domain per day.
- X limit (HTTP 429) → X paused until the next day.
- A user reply fails → the message stays saved with the provider's reason; Try again.
- Spam complaints are not detected in v1 (no reliable signal over IMAP).

### Leaving
- **Take a break**: pause until a date (Until Monday, Two weeks, Until January 6, or a picked date). Nothing automatic goes out; user replies still go. Resumes on its own at that date, or by Resume.
- **Wrap up**: cancels every scheduled message, optionally downloads an export (people + messages as JSON and a people CSV), optionally deletes all data. Talking people are handed back in the export with their channel and last message. Then "Start again any time".

### Projects
Added 2026-11-02 after Gabriel chose "Build projects into v1". Screens: `docs/design/boards/V4*.dc.html` (canvas page "projects").

- A **project** is one thing the user offers to one kind of person. It owns a name, an offer line, who to meet (`audience`), a voice (`tone` + `sample`), a calendar link, its people, its first-10-hellos approvals, and its own run state (`running`, `paused` until a date, or `wrapped`). Callum suggests a short name from the offer; the user can rename it. Names are unique (case-insensitive): "You already have a project called Payroll. Pick another name."
- **Shared by all projects:** the sender identity, the mailbox, LinkedIn and X accounts, and their daily limits ("20 emails a day across both projects"). When more is due than the limits allow, the earliest due goes first, whatever its project. A new project never asks to connect channels again.
- **One project per person.** Import skips anyone already in another project (reason `other_project`, "3 are already in Reconciliation"). Only strangers (no hello sent yet) and resting people can move to another project; anyone else gets the reason beside the action ("Kemi is talking with you about Reconciliation. Finish that conversation first.").
- **Stop applies everywhere.** A person who said stop in any project is never written to by any project, and is skipped on every import.
- **Across projects:** the dock, the morning brief, taps (notifications) and the weekly note cover every project; reply cards and list rows carry the project's name as a quiet text tag. Projects never get their own colors.
- **One project at a time:** the river, Day one, the Ask bar ("Ask Callum about Reconciliation") and Add people act on the project being viewed. The last viewed project is remembered.
- **Approvals:** the first 10 hellos need an OK in every project, counted per project.
- **Pausing:** "Take a break" (global) pauses everything. Each project can also pause on its own (until a date or until Resume): its automatic sends stay put; user replies still go. "Payroll is paused. Reconciliation keeps going."
- **Wrapping up one project:** cancels that project's scheduled messages, keeps people who are waiting or talking on the dock, offers that project's export, and marks it `wrapped` (hidden from the switcher, kept in Your Callum under "Wrapped"). "Wrap up everything" stays as before.
- **Upgrading:** an install with data from before projects gets one project built from its settings (named by Callum from the offer, else "My first project") holding every existing person.

## Architecture

- **One Node 22 process** (TypeScript, ESM) runs the HTTP API, the scheduler loop and the channel adapters. Data lives in one SQLite file (`node:sqlite`, no native build) under `CALLUM_DATA_DIR` (default `./data`).
- **Web UI**: React + Vite single-page app in the Daylight look, served by the same process. Phone layout below 720 px.
- **Engine** is pure functions over a `Clock`, so every time rule is unit-testable.
- **Channels** sit behind one `ChannelAdapter` interface: `email` (SMTP send + IMAP poll, app password), `linkedin` (Playwright driving the user's own logged-in browser profile), `x` (official X API v2 with an OAuth 2.0 user token), and `demo` (simulated, for trying Callum and for tests).
- **Writing** sits behind a `Writer` interface: `ClaudeWriter` (Anthropic API, `ANTHROPIC_API_KEY`) and `TemplateWriter` (no key needed). Same for reply classification and the Ask bar's intent parsing.
- **Lead sources**: CSV upload or paste, a LinkedIn search link (through the LinkedIn adapter), and "describe who to meet" through Apollo's people search when `APOLLO_API_KEY` is set.
- **Live updates**: Server-Sent Events. The server emits `changed` with a scope; the UI refetches `GET /api/state`.
- **Access**: binds to `127.0.0.1` by default. If `CALLUM_PASSWORD` is set it binds to `0.0.0.0` and requires a password cookie.

## Rulings on open questions

| Question | Ruling | Cost if wrong |
|---|---|---|
| Stack | TypeScript, Node 22, Hono, `node:sqlite`, React + Vite, Vitest, Playwright | Re-platforming later; low, the engine is pure TS |
| Where LinkedIn runs | On the machine running Callum, in a real browser profile. The status line says "LinkedIn runs on this computer while Callum is open." | Cloud users must paste an `li_at` cookie instead |
| Email provider | SMTP + IMAP with an app password for Google and other providers; Microsoft via OAuth2 device code (see below). "Continue with Google/Microsoft" opens the preset. OAuth sign-in is a later step (needs app verification). | Slightly more setup than the design's one-tap Google sign-in |
| Lead source | CSV/paste + LinkedIn search link always; Apollo search when keyed | Without Apollo, "describe who to meet" can only point to Bring a list |
| AI model | `claude-opus-5-5` by default (`CALLUM_MODEL` overrides), effort `low`, structured outputs; on any API error or refusal fall back to templates | API cost per message; set `CALLUM_MODEL` to change |
| Notifications | In-app brief plus browser notifications while a tab is open; no push server | No tap on a closed phone in v1 |
| Holidays | Not modeled | A hello may land on a public holiday |
| Hostile replies | Closed silently (see Replies) | Design wanted a polite close |
| Spam complaints | Not detected | No automatic slow-down on complaints |
| Multiple users | Single user per install | Teams are out of scope per the design |
| Desktop or web | Electron desktop app first (Gabriel, 2026-11-02: "i thought you were making an electron app" / "let's do that"); server mode second | Unsigned installers show a one-time OS warning until code signing is set up |
| Microsoft mail | OAuth2 device-code sign-in (XOAUTH2); Microsoft refuses app passwords | A one-time Azure app registration per install until Callum has a published client id |
| What a project owns | Offer, audience, voice, calendar link, people, approvals, run state; channels and pace are shared | Users wanting a second mailbox per project must wait for multi-mailbox |
| Pace across projects | Shared per account, earliest due first, no per-project quota | A big project can delay a small one's sends by a day |
| Person in two projects | Not allowed; move only strangers and resting people | A person relevant to two offers hears about one at a time |
| Stop scope | Global across projects | None; it's the safe reading of "stop" |
| Dock scope | All projects, tagged | A busy dock mixes offers |

## Out of scope (from the design's "not doing" list)
Dashboards, charts, open rates; sequence builder; unified inbox; CRM; lead marketplace; teams; A/B testing; dark mode; running inside other AI tools.
