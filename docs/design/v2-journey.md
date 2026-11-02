<!-- Plain-text export of the v2 design doc: https://claude.ai/artifact/TjxkwgBab5ZVLqbCcE4hso. Tables are flattened to "cell | cell" rows. -->

# Callum v2: designing the whole journey
 · 
## Context
Callum is for a founder who does their own outbound and has about 30 minutes a day for it. Rows marked as assumptions are my reading, not research, so correct anything that's off.
 | Our reading
 | Based on
 | 
Product
 | A standalone app that reaches out by email, LinkedIn and X on its own, and hands you only the people who reply
 | Gabriel: "cold emails, linkedin connections, and x messaging that runs itself"
 | 
User
 | A founder or first sales hire at a 2 to 20 person B2B startup, doing outbound alone
 | Assumption, close to Gabriel's own use
 | 
Moment of use
 | Morning coffee or between meetings, 2 to 5 minutes, laptop or phone, often right after a "someone replied" notification
 | Assumption
 | 
What they do today
 | A patchwork: a list tool, an email sequencer, a LinkedIn tool or invites by hand, X DMs by hand, and a spreadsheet to remember who is where
 | Assumption to validate
 | 
What hurts
 | Days of setup, messages that sound like templates, replies scattered across three inboxes and answered late, fear of a LinkedIn ban or the spam folder
 | Assumption to validate
 | 
Constraints
 | Standalone app; screens before code; open source on a small budget; no official LinkedIn API for this; X DMs need the paid API; email goes from the user's own mailbox within safe limits; opt-out laws such as CAN-SPAM and GDPR
 | Decisions so far
 | 
Loves
 | The v1 river and reply deck "as is"; light mode; seamless; not text-heavy
 | Gabriel
 | 
Hates
 | Generic SaaS dashboards ("this ui is some ass"); text-heavy apps
 | Gabriel
 | 
The only real quotes so far are Gabriel's, so the first validation step is five short calls with founders who do their own outbound.
## 1. Problem
Callum does the reaching out for you, and only interrupts you when a real person wants to talk.
Founders know exactly who they want to meet. Reaching them across three channels is a second job, and the few warm replies get lost in it.
What people have stopped noticing:
Three inboxes for one job. Replies land in Gmail, LinkedIn and X, so founders keep a spreadsheet just to know who is where.
Merge fields as personalization. "Hi {first_name}" feels normal to the sender, and recipients spot it in a second.
Open rates as progress. A good open rate feels like feedback but says nothing about who wants to talk. Open tracking also hurts deliverability.
The daily accept check. On LinkedIn, people check every day whether an invite was accepted before they can send the real message.
Embarrassing follow-ups. "Just bumping this up" is accepted as the price of outbound.
Late replies. A reply at 11 pm gets answered two days later, after it has gone cold.
Rationing by fear. People send slowly by hand because they can't see how close they are to a ban or the spam folder.
Setup as a rite of passage. Domains, warm-up and sequence builders take days before a single hello goes out.
The consequence for design: the unit of Callum is a person, not a message or a campaign. Everything else is plumbing Callum hides.
## 2. Journey
Four moments decide whether Callum sticks: the first reply, the first 60 seconds, the first time something breaks, and the daily two-minute check-in.
Daily use is the loop that matters: something breaks, Callum repairs it, and you're back. Leaving is either a pause that returns or a clean exit.
Stage
 | What they do
 | What they worry about
 | What Callum must do
 | 
Before
 | Hear about Callum from another founder or a post, then download it
 | "Will it embarrass me, get me banned, or take a week to set up?"
 | Promise three things up front: it sounds like you, it stays within safe limits, it's running in five minutes
 | 
First use
 | Sign in, connect channels, say who to meet, approve a voice, press Start
 | "What exactly goes out, to whom, and when?"
 | Show the plan before anything is sent. Nothing goes out the same day. You OK the first 10 messages
 | 
The wait, days 1 to 3
 | Open the app; nobody has replied yet
 | "Is it working?"
 | Show what went out and what's next. Ask for notifications now, not at sign-up
 | 
First reply
 | Tap the notification, read the reply, send Callum's draft or book a call
 | "Don't let me lose this one."
 | One tap from the notification to a ready reply in their voice
 | 
Repeat use
 | Two minutes a day: clear replies, glance at the river, ask for more people
 | "Is this growing?"
 | A morning brief, the reply deck, and a weekly note in people, not percentages
 | 
Something goes wrong
 | LinkedIn asks to verify, a mailbox disconnects, someone says stop
 | "Did Callum just hurt my reputation?"
 | Stop the affected channel first. Then say what happened, what Callum did, and the one thing to do next
 | 
Leaving
 | A holiday, a finished list, or quitting
 | "Will anyone get a strange message while I'm gone?"
 | Pause until a date, freeze follow-ups cleanly, export everything, hand conversations back
 | 
The moments that matter most, in order:
The first reply. It is the proof that Callum works. If it gets lost, nothing else matters.
The first 60 seconds. Trust is set before anything is sent: voice, safety, control.
The first failure. People forgive a pause. They don't forgive silence, or a message they didn't expect.
The daily check-in. If it takes more than two minutes, the habit breaks.
## 3. Concepts
We pick the River. Callum's work stays visible as people moving toward you, and your only job is the dock.
Bet
 | The promise
 | What it wins
 | What it costs
 | 
A. River, a visible autopilot
 | "Watch Callum bring people to you." Faces drift from stranger to talking. Replies step onto a dock you clear as a deck of cards
 | Progress at a glance. The autopilot is visible, which builds trust. Low text, and it delights
 | Must stay honest at 5,000 people. Finding one person is harder. It can slide into decoration
 | 
B. Brief, Callum as chief of staff
 | "Don't watch the machine. Callum tells you who wants to talk." A morning brief and a chat, no picture
 | The least UI. Flexible. Natural on a phone and in notifications
 | The machine is invisible, so trust collapses when something breaks. Chat is slow for repeated actions. Hard to discover what's possible
 | 
C. Ritual, a daily approval deck
 | "Three minutes a day, you approve every first touch." A daily stack of new people, first messages and replies
 | The highest quality and safety. A strong habit
 | Breaks "runs itself". Volume is capped by your attention. It feels like homework
 | 
The River is the only bet whose picture says "it runs itself" and still shows what it's doing. It borrows two pieces: the morning brief from B, as the notification, and approval from C, for the first 10 messages only.
What we're deliberately not doing:
No dashboards, charts or open rates. We show people, not percentages, and we don't track opens.
No sequence builder. Callum decides the timing. You can nudge, hold, or change the tone.
No unified inbox. Callum shows replies from people it contacted, nothing else.
No CRM. No deals, pipeline stages or custom fields. Export instead.
No volume dial past safe limits.
No lead marketplace or credits.
No teams, roles or seats in v2.
No A/B testing screens.
No dark mode yet.
No running inside other AI tools. Parked, as Gabriel asked.
## 4. Design
The whole model fits in one sentence: everyone starts as a grey stranger on the left, each hello moves them right, and people who reply step onto your dock.
### Conceptual model
v2 renames the stages so they're true on every channel: strangers, said hello, following up, talking. Talking now means a real conversation, because they replied and you answered.
Mappings. Left to right is cold to warm. Grey to colour is stranger to someone you know. Faces grow as people get closer. Sun yellow means "needs you" and is used for nothing else.
Two exits. After three unanswered touches, a person drifts out and rests for 90 days. Anyone who says stop leaves for good.
One person, one conversation. Callum picks the best channel for each person and never messages them on two channels in the same week.
### Key interactions
Go through replies. Reply with Callum's draft, Book a call, Snooze, or Close politely.
Peek at a person. Tap a face to see their path, what's next, and Nudge now or Hold.
Ask Callum. One bar for everything: find people, pause a channel, change the tone, ask who's warming up.
Approve the first 10. A short stack on day one. After that, Callum sends on its own.
Undo. Every message waits 10 seconds, with Undo, before it leaves.
Correct Callum. "That's an auto-reply", "Wrong person" and "Never contact" each teach it in one tap.
### Signifiers
Faces lift on hover, so they read as buttons.
The sun ring and "3 people want to talk" say where your attention goes.
Flowing water means Callum is working. Still water means it's paused.
Suggestion chips under the Ask bar show what you can say.
Every card names its channel, so you know where your reply will go.
An unavailable action says why beside it, instead of just turning grey.
### Feedback for every action
Action
 | Right away
 | Later
 | 
Connect a channel
 | A ring spins, then a check and today's pace
 | A warning on the channel if it disconnects
 | 
Describe who to meet
 | "Callum is looking", then a live count as faces pour into the river
 | Callum flags anyone who doesn't fit
 | 
Pick a tone
 | The sample message rewrites in place
 | Callum learns from your edits
 | 
Start
 | Water starts to flow, the status says Running, and "First hellos go out tomorrow at 9:00 their time"
 | A morning brief after the first sends
 | 
OK a first message
 | The card slides away and the counter drops: "7 left"
 | "That's all 10. Callum runs on its own now."
 | 
Send a reply
 | The card lifts away; a toast holds a 10-second Undo
 | "Sent" shows on Amara's face
 | 
Book a call
 | The card slides right: "Calendar link sent to Amara"
 | "Amara booked Thursday at 2:00 pm"
 | 
Snooze
 | The card slides left: "Mei comes back on Monday"
 | Mei returns to the dock on Monday
 | 
Nudge now
 | The face pings and moves one step right
 | The next step shows in the face's card
 | 
Hold
 | The face turns grey
 | Nothing goes to them until you resume
 | 
Pause
 | The water stops; the status turns grey: "Nothing goes out until you resume"
 | A reminder after three days paused
 | 
Ask
 | An answer card with faces and one action
 | The river changes when you act on it
 | 
### Smart defaults
Setting
 | Default
 | Why
 | 
Sending hours
 | 9:00 to 17:00 on weekdays in the recipient's time zone, skipping their public holidays
 | Messages land when people read them
 | 
Email pace
 | 20 a day per mailbox, rising to 120 over three weeks
 | Protects a new address's reputation
 | 
LinkedIn pace
 | 15 invites a day, working hours only, pauses itself on any warning
 | Gabriel's chosen balance of speed and account safety
 | 
X pace
 | 20 DMs a day
 | Stays inside the X plan's limits
 | 
Touches
 | Up to 3 per person over about two weeks, then rest for 90 days
 | Persistent, never pushy
 | 
Channel
 | One at a time per person, chosen by where they're active
 | No double-tapping
 | 
First messages
 | You OK the first 10, then Callum runs on its own
 | Trust is earned, not assumed
 | 
Replies to people
 | Callum drafts, you send
 | Relationships start with you
 | 
Opt-outs
 | Any "stop" ends all contact; every email carries a one-line opt-out
 | The law, and decency
 | 
People you know
 | Skips anyone you've emailed before and any customer
 | No cold hello to a friend
 | 
Notifications
 | Replies only, gathered into an 8:30 brief, unless someone wants to talk this week
 | Interrupt for people, not machinery
 | 
## 5. Walkthrough
Walking v1 as built, a first-timer hesitates five times in 60 seconds, and the biggest gap is that Callum never asks what they sell.
Time
 | What they see
 | What they think they can do
 | Where they hesitate or slip
 | 
0 to 5 s
 | "Where should Callum reach people?" and three grey discs
 | Tap a disc to connect it
 | "Which address will it send from? Do I give it my LinkedIn password?"
 | 
5 to 15 s
 | A Google sign-in window, then a check and "120 emails a day"
 | Move on
 | "120 a day from my real address sounds like spam." Some connect a personal Gmail by mistake
 | 
15 to 25 s
 | "Who do you want to meet?", an empty bar and three chips
 | Type, or tap a chip
 | "I already have a list. Where does it go?" Typing "startups" matches far too many people
 | 
25 to 35 s
 | A count climbs to 40 as grey faces pour into the river
 | Press Next
 | "Who are these people? Can I check them?" They can't
 | 
35 to 50 s
 | "How should Callum sound?" and a sample about reconciliation
 | Switch between Warm, Direct and Playful
 | "That's not what I sell." Callum never asked
 | 
50 to 60 s
 | "Callum sends on its own" is on, then Start Callum
 | Press Start
 | "Will it email 40 people right now?" They hesitate here, or back out
 | 
Revisions for v2:
Sign in with Google or Microsoft first. The mailbox connects in the same step, and the screen names the address that sends.
Explain LinkedIn before the tap. "You sign in on LinkedIn's own page. Callum never sees your password."
Show the ramp, not the ceiling. "20 a day this week, up to 120 by week three."
Add Bring a list beside the describe bar, for a CSV or a LinkedIn search link.
Narrow a vague ask with one question. Too many matches gets chips for role, company size and place.
Let people peek at who was found and remove anyone, which also teaches Callum.
New step: "What do you offer?" Callum reads the website behind your email domain and proposes one line to confirm or edit.
Make the sample message editable. Callum learns from the edits.
Replace the switch with a default: you OK the first 10, then Callum runs on its own.
Show the plan before Start. "Tomorrow from 9:00 their time: 12 hellos, 8 by email and 4 on LinkedIn. Nothing goes out today." The button says "Start tomorrow at 9:00".
Revised, the flow gains two short steps and loses every open question. At Start, the person knows which address sends, how LinkedIn connects, what Callum will say, and exactly when it begins.
## 6. Details
Every state below has words and a next step. Every error says what happened, what Callum already did, and what you can do.
### Empty states
Where
 | What it says
 | The action
 | 
River before anyone is added
 | "Your river is empty. Tell Callum who you want to meet."
 | Puts the cursor in the Ask bar
 | 
First days, no replies yet
 | "No replies yet, which is normal this early. Callum will tap you the moment someone answers."
 | Shows what goes out next, and when
 | 
Dock cleared
 | "All caught up. Callum keeps the river moving."
 | Back to the river
 | 
A search finds nobody
 | "Nobody matched 'heads of ops in Accra'. Try a wider role or a nearby city."
 | Suggested edits as chips
 | 
A group is used up
 | "Everyone in this group has heard from you."
 | "Find more like the people who replied"
 | 
### Errors
What happened
 | What Callum says
 | What you can do
 | 
LinkedIn asks to verify the account
 | "LinkedIn asked to check it's you, so Callum paused LinkedIn to keep your account safe. Email and X keep going."
 | Open LinkedIn, finish the check, then Resume. Callum goes at half pace for a week
 | 
LinkedIn's weekly invite limit
 | "LinkedIn's weekly invite limit is reached. New invites wait until Monday. Messages to your connections keep going."
 | Nothing, or move these people to email
 | 
Mailbox signed out
 | "Google signed Callum out of you@yourcompany.com. 14 emails are waiting and nothing was lost."
 | Reconnect Google
 | 
Emails bounce
 | "8 addresses at fieldnote.com bounced. Callum removed them and will try LinkedIn for those people."
 | Undo, to skip them instead
 | 
Someone marks you as spam
 | "Someone marked your email as spam. Callum slowed email to 20 a day for a week to protect your address."
 | Read the message that caused it
 | 
X refuses messages
 | "X stopped accepting Callum's messages because your X plan's daily limit is reached. DMs resume tomorrow."
 | Wait, or raise the X plan
 | 
A draft has a placeholder
 | "Add your price first. Callum never sends a message with [YOUR PRICE] in it."
 | The placeholder is highlighted in the draft
 | 
A reply fails to send
 | "Your reply to Tomás didn't go out: Gmail says the mailbox is full. It's saved here."
 | Try again, or copy it
 | 
Someone says stop
 | "Ruth asked not to be contacted. Callum stopped everything and won't reach out again."
 | Nothing. It stays in Ruth's history
 | 
You're offline
 | "You're offline. Callum keeps working, and your changes sync when you're back."
 | Nothing
 | 
### Loading
Finding people: a live count while faces pour into the river, never a spinner.
Drafting a reply: the draft fills in from a short placeholder; the buttons stay usable.
Connecting: a ring turns around the channel. If the sign-in window is hidden: "Finish signing in on the Google window", with Reopen.
Sending: the toast holds a 10-second ring with Undo.
### Edge cases
Reply on another channel. Callum merges it into the same person.
Same person in two groups. They hear from you once.
You reply yourself from Gmail or LinkedIn. Callum notices and stops its follow-ups for that person.
Out-of-office replies don't count as replies. Callum waits until the return date.
Referrals ("talk to my colleague Sam"). Callum adds Sam as a warm intro, with the context.
A reply in another language. The draft comes back in that language.
A hostile reply. Callum closes politely, never contacts them again, and keeps it off your dock.
Big lists. Past about 60 faces, each face stands for a group, and the counts stay exact.
Keyboard and screen readers. A list view shows the same people as rows, and every face is a named button.
### Microcopy
Talk like a calm colleague: first names, plain words, no exclamation marks.
Exact times beat vague ones: "Thursday at 9:00", never "soon".
Never blame the person, and never hide what Callum did.
We say
 | We don't say
 | 
people
 | leads, prospects, contacts
 | 
hello, follow-up
 | touch, step, cadence
 | 
talking
 | engaged
 | 
resting, let go
 | churned, dead
 | 
pause
 | disable
 | 
Callum
 | the system, the AI
 | 
One open question: where LinkedIn runs. From the cloud it is always on but riskier; from the desktop app it only runs while the app is open. The status line must say which.
## 7. The v2 screens
v2 adds six screens for the moments above, on a v2 page of the Callum UI canvas. v1 stays as it is on its own page.
Screen
 | Moment
 | What's new
 | 
First run
 | The first 60 seconds
 | Sign in with Google first, the ramp instead of the ceiling, "What do you offer?", Bring a list, peek at who was found, an editable sample, and the plan before Start
 | 
Day one
 | The wait
 | OK the first 10 hellos one by one, then Callum runs on its own
 | 
A morning with replies
 | The first reply and the daily check-in
 | Renamed stages, answered people settle into Talking, Close politely, a 10-second Undo, a list view
 | 
LinkedIn paused
 | Something breaks
 | The LinkedIn part of the river goes still, and one card says what happened, what Callum did, and what to do
 | 
Pause or wrap up
 | Leaving
 | Pause until a date, or export everything and hand conversations back
 | 
Phone
 | The first reply
 | From the morning brief to a sent reply, with Undo
 | 
