# Callum projects boards

Gabriel wants more than one project in Callum. A project is one thing you offer to one kind of person. Example: "Reconciliation" (fintech ops teams) and "Payroll" (heads of people at growing companies in Lagos and Accra). Design the project screens in the same Daylight look and the same .dc.html format, helpers and data as the existing boards.

Workspace: /tmp/claude-0/-home-claude/2924407f-a599-5f5d-aa9e-280e330ff670/scratchpad/callum-design/project/
Copy these from V2Morning.dc.html and the V3*.dc.html boards there:
- the head block (support.js, Onest, base CSS, reduced-motion block)
- the header (callum wordmark with sun dot, status pill)
- the marble() avatar helper, the river, the dock, toasts, panels and animation classes

Read V2Morning.dc.html (home), V3Settings.dc.html (Your Callum) and V3AddPeople.dc.html first, because these boards extend them.

## Projects

Project 1 is "Reconciliation". Offer: "You help fintech teams take reconciliation off their ops team's plate." It has the usual people: Kemi Eze at Oko Pay, Femi at Eko Wallet, Zainab at Lagoon Pay, Chidi, Bisi at Ikoyi Pay, Ngozi, Tunde at Ireti Labs, Emeka at Surulere Labs, Seun at Lekki Ledger, Ada, Nneka, Temi, Ruth, Tomás, Amara, Mei and Sam Bello.

Project 2 is "Payroll". Offer: "You help growing teams in Lagos and Accra run payroll without spreadsheets." Its tone is Direct. Its people are Yaw Mensah at Kumasi Foods, Efua at Osu Health, Kwame, Halima at Abuja Freight, Dayo at Yaba Studio, Ama, Kofi, Ifeoma, Musa and Bukola. Yaw replied: "Happy to look. We run 140 people on a spreadsheet today."

Gabriel sends from gabriel@yourcompany.com.

## Product rules the screens must show

These are already decided. Do not change them.

**Projects own:** a name, an offer, who to meet, a voice (Warm, Direct or Playful), a calendar link, and their own people. Callum suggests a short name from the offer, and you can rename it.

**Shared across projects:**
- Mailbox, LinkedIn and X accounts are shared.
- So are the daily limits ("20 emails a day across both projects").
- A new project doesn't connect channels again.

**One project per person:**
- Importing skips anyone already in another project ("3 are already in Reconciliation").
- Only strangers and resting people can move between projects. Anyone else shows the reason beside the action: "Kemi is talking with you about Reconciliation. Finish that conversation first."

**Stop applies everywhere.** Someone who said stop in one project is never written to by another.

**What spans every project and what doesn't:**
- The dock (people who replied and wait on you), the morning brief, taps and the weekly note cover all projects.
- Each reply card carries a small project tag, a quiet text chip, not a color.
- The river shows one project at a time.

**Approvals:** the first 10 hellos need an OK in each new project, because new words deserve a look.

**Pausing and wrapping up:**
- "Take a break" pauses everything.
- Each project can also pause on its own ("Payroll is paused. Reconciliation keeps going.").
- Each project can wrap up on its own. That cancels its scheduled messages and offers its export.

**The Ask bar works on the project you're looking at.** "Find 20 more like Kemi" adds to Reconciliation.

## Boards

### 1. V4Projects.dc.html, "Projects" (1440x900, interactive)

The home screen (V2Morning look) with projects.

**Switcher.** The project name sits next to the wordmark as a quiet switcher, for example "callum · Reconciliation". Clicking it opens a small sheet in place, with each project as a row:
- name
- a strip of 5 to 7 faces
- one line in people words: "18 people, 3 talking" or "Paused until Monday"
- "New project" at the bottom

Switching projects cross-fades the river to that project's faces, offer line and next hellos. The dock stays put, because it is shared.

**Dock.** It shows replies from both projects. Kemi carries "Reconciliation" and Yaw carries "Payroll". Opening Yaw's card shows a draft in the Direct voice.

**Day one in Payroll.** When you switch to Payroll, its river shows its own Day one state: "7 of 10 hellos left to OK in Payroll" with the deck of hellos to OK, in V2DayOne style, but scoped.

**Pausing a project.** Pause just Payroll from the switcher row's "…" menu (Pause / Wrap up / Rename). The river goes still, with the line "Payroll is paused. Reconciliation keeps going." and Resume.

**Ask bar.** It shows the current project as its placeholder: "Ask Callum about Reconciliation".

### 2. V4NewProject.dc.html, "A new project" (1440x900, interactive)

Opened from "New project". It is a calm three-step flow in First run style (V2Start), without the channel step.

1. **What do you offer?** A one-line field. Callum suggests a name under it as you type ("Callum will call this Payroll", with a rename pencil).
2. **Who should Callum meet?** Ways in: Describe who, Drop a CSV, Paste names, LinkedIn search link. Use the describe path with chips, as in V3AddPeople. The preview shows faces, the count, and skipped people with reasons, including "3 are already in Reconciliation" and "1 asked not to be contacted".
3. **How should you sound?** Warm, Direct or Playful, with the sample hello rewritten in place.

Then a short "What's shared" line: "Uses your mailbox, LinkedIn and X. Their daily limits are shared with Reconciliation."

Start runs a ring animation, then: "Payroll is ready. You'll OK the first 10 hellos tomorrow from 9:00." The river fades in with strangers.

Include one error state, a duplicate name: "You already have a project called Payroll. Pick another name."

### 3. V4ProjectSettings.dc.html, "Projects in Your Callum" (1440x900, interactive)

The V3Settings column, extended with a "Projects" row near the top. It opens in place to show each project as a row. Opening a project row shows:
- its name (editable)
- what you offer (editable)
- who to meet (one line)
- how you sound (chips that rewrite the sample)
- the calendar link
- "Pause Payroll" / "Wrap up Payroll" with an in-place confirm: "Wrap up Payroll? 6 scheduled hellos are cancelled. 2 people you're talking with stay in your dock. Download Payroll's people first." with "Download and wrap up" / "Wrap up" / "Keep it"

Keep the "Where Callum reaches people" row, and make the shared pace explicit there: "20 emails a day across both projects, 120 by week 3."

Also show "A person, moving project" as a small inline demo in this board, in a side panel or as a flip state. Opening Ngozi (resting) shows "Move to Payroll", which is available. Opening Kemi (talking) shows the move as unavailable, with the reason beside it.

### Phone

Also add a phone variant (390x844) as V4Phone.dc.html, "Projects on phone":
- the top bar shows the project name as a switcher
- a bottom sheet lists the projects
- the River tab shows one project
- the replies list mixes projects with tags

## Rules for every board

- **Colors:**
  - light mode, white ground
  - ink #1D2140, slate #646B85, mist #F4F5F9, line #E7E9F0
  - sun #FFB020 / tint #FFF3D6 only for people who replied and for Callum's voice
  - green #22B07D
  - error tint #FFF1EC with icon #D9480F
  - stage rings #D5D9E4 #A9B8F5 #6E86F2 #3F52D9
- **Font:** Onest.
- **Projects get no colors of their own.** They are told apart by name and by their faces, never by a color code. That would be dashboard-ish and would fight the stage rings.
- **Layout:**
  - low text and seamless; details open in place; faces instead of rows
  - no dashboards, charts, percentages, ALL-CAPS labels or exclamation marks
  - exact times ("Thursday at 9:00")
- **Words:**
  - use people, hello, follow-up, talking, resting, pause, Callum, project
  - never leads, contacts, touch, cadence, engaged, disable, campaign, workspace, or "the AI"
- **Errors and unavailable actions:**
  - every error says what happened, what Callum already did, and the one thing to do
  - every unavailable action says why beside it
- **Technical:**
  - each board is interactive and works at 1440 wide (the phone board at 390x844)
  - each has a 760px media query and a reduced-motion block
  - each passes the smoke harness: `node smoke-generic.js <file> <steps.js>`, run from the scratchpad dir. Look at steps-v3*.js there for the step-script format. There must be no missing holes, no NaN/undefined, loops ok, and all timers cleared on unmount.
- **Visual check:** render each board with `node render.js <board> <out.png> - [w h]` and look at the PNGs yourself. Use the Read tool on the png, and fix anything cramped, overlapping or off-tone.

## Canvas

In callum-design/project/canvas.json:
- Add page {"id":"v4","name":"projects"}.
- Add the title note "Callum: projects" for page v4.
- Place the boards in one row at x = 0, 1520, 3040, 4560, y = 0, all with "page":"v4", "is_interactive": true, "expand":"fill" (desktop only).
- Titles: "1. Projects at home", "2. A new project", "3. Projects in Your Callum", "4. Projects on phone".
- Append them to "order".
- Set "launch" to page "v4".

Do not touch the other boards.

Do not publish. The controller publishes.
