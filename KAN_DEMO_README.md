# Kan — tomorrow’s demo script

**Demo:** Sunday, 20 September 2026

**Presenters:** Enric and Juanjo

**Story:** Plan a hackathon together in three stages: dates → venue → sponsors.

This is a simulated planning conversation, not a claim that we are booking a future event. Use September 2026 explicitly so the calendar does not drift to another year.

## Before sharing the screen

- Both presenters join the same shared canvas, with both video tiles visible and voice mode enabled.
- Prevent echo: mute the call’s audio path as rehearsed, while keeping each presenter’s AI voice input active. Do not assume those controls are independent; verify tonight. Use headsets if muting also disables transcription.
- Start with an empty canvas. Have the tested sponsor CSV ready on Juanjo’s computer.
- Speak to each other naturally. No typing prompts, pressing Send, or secretly creating nodes. The AI should recognize opportunities and act on the conversation.
- Every core change should be visible on both screens within **2 seconds of finishing the relevant sentence**.

## Opening — say this before screen sharing

**Enric:**
> “This year we built Kan, a collaborative canvas with AI embedded in the conversation. Our breakthrough is making the AI a teammate: it can follow several people, join the discussion, and act on the canvas as decisions change. Let’s show you by planning a hackathon together.”

**Share the screen:** show the canvas and the video call with Enric and Juanjo.

## Stage 1 — choose the dates

| Who | Say out loud | What the audience sees |
| --- | --- | --- |
| Enric | **“First, we need to decide the date for our two-day hackathon in September 2026.”** | The AI immediately creates a September calendar, with **no date selected**. |
| Juanjo | **“How about Saturday, the 26th of September?”** | The same calendar selects **26 September**. No second calendar appears. |
| Enric | **“But Thursday the 24th is La Mercè, a public holiday in Barcelona. Let’s avoid that weekend and do the 19th and 20th instead.”** | The same calendar switches to **19–20 September**. A tiny connected note appears: **“La Mercè: Barcelona public holiday on Thu 24 Sep; we chose 19–20 Sep to avoid that weekend.”** |

**The point:** nobody asked for a calendar. The AI noticed the need, then followed a correction from a different person and captured the reason.

## Stage 2 — compare venues

| Who | Say out loud | What the audience sees |
| --- | --- | --- |
| Juanjo | **“For the venue, what about Glovo?”** | A map appears with **Glovo Yellow Park / Glovo HQ in Barcelona** marked. |
| Enric | **“We used Glovo last year, so this time let’s try Norrsken House Barcelona.”** | The same map adds and focuses **Norrsken**. Glovo remains an alternative, not the selected venue. |
| Juanjo | **“I think Glovo could fit around 200 people, but we need to confirm that. What about Norrsken’s capacity?”** | Small connected notes record **“Glovo: ~200 people — speaker estimate, unverified”** and Norrsken’s sourced capacity for the relevant room/layout, or **“Capacity to confirm.”** |
| Enric | **“Glovo is familiar; Norrsken gives us a new setting. Let’s compare capacity and availability before we commit.”** | The notes gain concise pros, cons, and open questions. Norrsken is preferred, not falsely marked as booked. |

**The point:** the AI does more than drop a map onto the canvas. It records the discussion and attaches useful context to the object being discussed. Spoken estimates stay labeled as estimates; researched facts carry a source. Do not wait on a long web search during the demo.

## Stage 3 — shortlist sponsors, then discard one

| Who | Say out loud / do | What the audience sees |
| --- | --- | --- |
| Juanjo | **“I have a CSV of sponsor candidates with estimated sponsorship revenue. These are sample numbers for the demo—let me upload it.”** Upload the prepared CSV. | A labeled chart appears with company names, logos, EUR values, and a short text summary. Include **Preply, SLNG, Vonage, Cognition, Nebius**, and **The Coca-Cola Company** as a deliberate extra candidate. |
| Enric | **“Let’s shortlist Preply and SLNG.”** | Both candidates are visibly selected/shortlisted in the existing chart. |
| Juanjo | **“Coca-Cola doesn’t fit this event. Let’s discard that one.”** | Coca-Cola is visibly **crossed out and marked Discarded**, and excluded from the active shortlist and its total. Other candidates remain unchanged. |

Crossing out is the preferred visual treatment because the audience can see the change; removing the candidate from the chart is also acceptable. Pick and rehearse one treatment tonight. This is the demo’s explicit removal/discard moment.

**The point:** the AI understands “that one,” changes existing content, and keeps up with decisions from both speakers.

## Closing — one sentence

**Enric:**
> “We didn’t stop the conversation to operate the software—the canvas kept up with us.”

## Presenter notes — not spoken

- Likely dictation corrections used here: **Global → Glovo**, **Nordscan → Norrsken**, **Slang → SLNG**, **Hackvana → HackBarna**. Confirm these are the intended names at rehearsal.
- The server-side assistant was described as **Jeff / JJEV**. Its visible responsibility is to notice the opportunity and **create/show** the calendar, then update it—not close it. Internal service names are unnecessary in the spoken pitch.
- Avoid “this does not exist anywhere else”: the demo should demonstrate the difference without an unsupported world-first claim.
- No venue capacity is verified in this script. Published attendee counts are not venue capacities; room layout, desks, and availability need confirmation.
- The sponsor names below are real event references. The CSV values are fictional planning estimates, not company revenue, actual donations, or sponsorship commitments. Coca-Cola is only a demo candidate, not a claimed HackBarna sponsor.
- If something misses the two-second target, do not pretend it happened. Retry once with a clear restatement; report the failure during rehearsal.

### Fact-check references

Checked 19 September 2026:

- [Barcelona City Council — 2026 public holidays](https://ajuntament.barcelona.cat/calendarifestius/en/): 24 September is Mare de Déu de la Mercè, a local Barcelona holiday.
- [HackBarna AI Summit 26 — official event and sponsors](https://www.hackbarna.com/en/events/aisummit26): 19–20 September at Norrsken; sponsors include Preply, SLNG, Vonage, Cognition, and Nebius.
- [AI Summit Barcelona — hackathon](https://aisummitbarcelona.com/hackathon): Norrsken House Barcelona, Passeig del Mare Nostrum, 15.
- [HackBarna event history — eventoplus](https://www.eventoplus.com/en/articles/hackbarna-turns-a-weekend-into-an-artificial-intelligence-lab/): the 2025 edition took place at Glovo Yellow Park.

**Engineering handoff:** see `KAN_OVERNIGHT_README.md` alongside this file.
