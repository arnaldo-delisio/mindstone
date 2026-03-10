---
name: brief
description: Morning briefing. Reads today's plan, GCal schedule, and backlog. Suggests first action using Eisenhower inference. Offers to plan inline if no plan was written by shutdown.
invocation_pattern: /brief
auto_invoked: false
---

# Brief Skill

Morning briefing ritual. Surfaces the day's plan, fixed events, and floating work — then suggests where to start.

---

## Step 1: Gather Context (run in parallel)

**Today's daily note:**
Read `daily/YYYY-MM-DD.md` (today's date). Extract the `## Plan` section if present.

**Today's calendar:**
```
get_calendar_events({ days: 1 })
```

**All events (backlog + upcoming):**
```
list_events({ filter: 'all' })
```

---

## Step 2: Check for Plan

**If `## Plan` is found** → proceed to Step 3.

**If no `## Plan` found:**
Look back at recent daily notes (up to 7 days) to find the last one with a `## Plan` section. Read them in reverse chronological order, stopping at the first hit.

**If a previous plan is found**, always go through the adjust flow:
1. Scan for active GSD phases: `find ~/ -name "STATE.md" -path "*/.planning/*" 2>/dev/null` — read each, extract project name + current phase + status
2. Show the previous plan alongside today's calendar + backlog + GSD phases:
   ```
   No plan for today — last plan was from {date}:

   {plan contents verbatim}

   Here's what's new since then: {calendar events} | {backlog items} | {open GSD phases}

   What carries over, what changes, anything new to add?
   ```
3. Discuss conversationally — what carries over, what's new, what to drop
4. Write the updated `## Plan` to today's daily note (creating if needed), same hybrid format as shutdown (prose intention + optional `### Personal` + project-grouped checkboxes — no tasks in the narrative prose)
5. Proceed to Step 3 with the new plan

**If no plan found in the last 7 days**, display:
```
⚠️ No plan found for today or recent days — shutdown wasn't run recently.

Want to do a quick planning session now? I'll pull your GCal, backlog, and active GSD phases.
```
If yes → same adjust flow as above (steps 1–5).
If no → proceed to Step 3 without a plan.

---

## Step 3: Display the Briefing

Format:

```
# Brief — {date} ({day of week})

## Plan
```
{contents of ## Plan section — verbatim, inside a code block so [ ] and [x] render correctly}
```
(if no plan: "No plan for today.")

## Schedule ({count} events)
HH:MM — Title (calendar)
...
(if none: "Nothing scheduled — free day")

## Backlog ({count} items)
- Title [🔴 urgent] [⭐ important]
...
(up to 8 items, prioritize urgent+important first)
```

### Display rules
- Plan section: always wrap in a fenced code block — Claude Code terminal strips `[ ]` from GFM task lists, so verbatim display is required
- Times in Europe/Rome format (HH:MM)
- Calendar in parentheses: (work), (health), (family), (personal), (content)
- Backlog: max 8 items, `urgent` flag = 🔴, `important` flag = ⭐
- No "Next 2 Days" section — brief is focused on today only

---

## Step 3b: Past Events Reconciliation (always run, before Step 4)

From the `list_events({ filter: 'all' })` result fetched in Step 1, find events where:
- `status: 'upcoming'`
- `start_time` is in the past (compare against current time, Europe/Rome)

If any found, display them and ask for confirmation:

```
## Past Events — did you do these?
- Book dentist appointment (09:30) → done / skip
- ...
```

For each event the user confirms as done → call `manage_event complete`.
For skipped → leave as-is (will resurface tomorrow).

**Display rules:**
- Show title + time only (no calendar, no flags)
- If none → skip this section entirely, no mention of it
- Do NOT ask as a separate question — list them all at once and let the user respond in one message (e.g. "1 yes, 2 no" or "all done" or "none")
- After processing confirmations, proceed to Step 4

---

## Step 4: Suggest First Action

After displaying the briefing, synthesize everything (plan tasks, calendar events, backlog) and suggest what to tackle first.

**Inference rules:**
- Fixed calendar events are constraints — don't suggest work that overlaps
- Plan tasks are pre-committed intentions — weight them heavily
- Backlog items with `urgent: true` + `important: true` override plan if not already covered
- For ambiguous items (no flags, unclear scope), ask: "Is [task] urgent today or can it wait?"

End with a concrete suggestion:
```
I'd start with [task] — [one-sentence reasoning].
```

If the total number of open items (unchecked plan tasks + backlog items) is **5 or more**, append:
```
Want me to map everything with the Eisenhower matrix?
```
Otherwise, skip the Eisenhower offer — it adds no value when the path forward is already obvious.

---

## Step 5: Eisenhower Matrix (on request only)

Only display if the user says yes.

Map all items (plan tasks + backlog + any unblocked GSD work) to quadrants:

```
## Eisenhower Map

**Q1 — Do First** (urgent + important)
- [item]

**Q2 — Schedule** (important, not urgent)
- [item]

**Q3 — Delegate / Defer** (urgent, not important)
- [item]

**Q4 — Drop** (not urgent, not important)
- [item]
```

**Classification rules:**
- Use `urgent`/`important` frontmatter flags from backlog events where available
- For plan tasks and calendar events, infer from context:
  - Deadlines, meetings, client work → urgent
  - Deep work, learning, building → important but rarely urgent
  - Admin, notifications, minor errands → urgent but not important
  - Speculative/nice-to-have → neither
- If genuinely unsure about an item → ask before placing it
- After displaying: "Anything to reclassify?"
