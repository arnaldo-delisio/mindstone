---
name: shutdown
description: End-of-day shutdown ritual. Closes today (log anything unlogged, handle past events), shows rolling 7-day week pulse with carry-overs and goals progress, triggers review cycle if 7+ days since last, then plans tomorrow informed by week context.
invocation_pattern: /shutdown
auto_invoked: false
---

# Shutdown Skill

Three-phase end-of-day ritual: close today → week pulse → plan tomorrow.

---

## Phase 1 — Close Today

### Step 1.1: Read today's daily note

Read `daily/YYYY-MM-DD.md` (today's date). Note what's already logged.

### Step 1.2: Check for past upcoming events

Call `list_events` with filter `today`:

```
list_events({ filter: 'today' })
```

For each past event still marked `upcoming`, ask conversationally: "Did [event name] happen?" → `manage_event complete` or `manage_event cancel` based on response.

### Step 1.3: Ask about anything unlogged

Ask: "Anything to log before closing today?"

If yes — append to today's daily note under the appropriate section:
- Work completed, problems solved → `## Work`
- New ideas, future things to explore → `## Ideas`
- Something learned → `## Learning`
- Content-related → `## Content`

Infer section from context. If unclear, ask: "Should this go under Work, Ideas, Learning, or Content?"

Use Edit to append to the existing section. Do NOT rewrite the whole file.

---

## Phase 2 — Week Pulse

### Step 2.1: Load last 7 days (run in parallel)

Read `daily/YYYY-MM-DD.md` for today and the 6 preceding days. Skip any day where the file doesn't exist.

From each daily note extract:
- **Carry-overs:** lines matching `- [ ]` inside the `## Plan` section only
- **Work titles:** bold timestamp lines (`**HH:MM - Title**`) inside `## Work`

Also in parallel:
- Glob `goals/weekly/*.md` → sort descending → read the most recent file
- Glob `reviews/weekly/*.md` → sort descending → get the filename of the most recent file

### Step 2.2: Identify carry-overs

A task is a carry-over if it appears unchecked (`- [ ]`) in **2 or more** daily notes across the 7-day window. Track how many days it has been unchecked.

### Step 2.3: Grade weekly goals

If a weekly goals file was found:

For each target in the `## Targets` section:
- ✓ if the task appears checked (`- [x]`) in any daily plan in the window
- ~ if there's evidence of progress (work title mentions it, or it appeared unchecked recently but not in older days)
- ✗ if no evidence of progress across the window

If no weekly goals file → skip this section silently.

### Step 2.4: Display Week Pulse

```
## Week Pulse ({start date} – {today})

### Goals
✓ target 1
~ target 2 (in progress)
✗ target 3

### Carry-overs
- [task] — unchecked N days
- [task] — unchecked N days

### Work shipped
- project-a: [2-3 session titles]
- project-b: [2-3 session titles]
- vault: [session titles]
```

Group work shipped by project — infer project from session titles.

If no weekly goals file: omit Goals section entirely.
If no carry-overs: "No carry-overs — clean week."
If no work entries found: "No work logged this week."

### Step 2.5: Review trigger

Calculate days since last review:
- If `reviews/weekly/` is empty or missing → `days_since = ∞`
- Otherwise → parse date from most recent review filename (`YYYY-MM-DD.md`) → calculate days since today

If `days_since >= 7`:

```
You haven't done a review in {N} days — close this cycle tonight?
```

If yes → run Step 2.6.
If no → proceed to Phase 3.

### Step 2.6: Review Flow

Run conversationally, one question at a time:

1. "What worked well this week?"
2. "What would you do differently?"
3. "What's the win of the week?"

After answers, grade goals formally — confirm ✓/✗ for any target marked `~` (in progress).

Write `reviews/weekly/YYYY-MM-DD.md` (today's date):

```markdown
---
date: YYYY-MM-DD
period_start: YYYY-MM-DD
period_end: YYYY-MM-DD
goals_hit: N/M
type: review
tags:
  - review
---

## Goals
- [x] target 1
- [ ] target 2
- [ ] target 3

## Work Shipped
[1-2 paragraph prose summary of the week's output across all projects]

## Reflections
**What worked:** [answer]
**What to do differently:** [answer]
**Win of the week:** [answer]
```

After writing the file, ask: "Want to set next week's goals?"

If yes → read current quarterly goals as context, then ask for theme + 3 targets → create `goals/weekly/YYYY-WNN.md` (next week's ISO week number) using the weekly file format from the goals skill.

---

## Phase 3 — Plan Tomorrow

### Step 3.1: Gather context (run in parallel)

- `get_calendar_events({ date: 'YYYY-MM-DD', days: 1 })` — tomorrow's date
- `list_events({ filter: 'backlog' })`
- `find ~/ -name "STATE.md" -path "*/.planning/*" 2>/dev/null` → read each, extract project name + current phase + status
- Weekly goals file already loaded in Phase 2 — reuse it here

### Step 3.2: Display tomorrow's context

```
# Shutdown — {today's date}

## Tomorrow — {date} ({day of week})

### Calendar ({count} events)
HH:MM — Title (calendar)
...
(if none: "Nothing scheduled — free day")

### Backlog ({count} items)
- Title [urgent/important badges if set]
...
(up to 8 items, prioritize urgent+important)

### Active Work
- **{project}** — Phase {N}: {phase name} ({status})
...
(if none: "No active GSD phases")

### Weekly Focus
Theme: [theme]
Remaining: target 2 / target 3
```

Omit Weekly Focus section if no goals file exists. Omit remaining targets if all are done.

---
What do you want to work on tomorrow?

### Step 3.3: Discuss and build the plan

Have a conversation. Ask follow-up questions if needed. Reference carry-overs from Phase 2 where relevant: "The delisio audit has been unchecked 3 days — want to anchor tomorrow around it?" Keep going until the plan is clear and agreed.

### Step 3.4: Write the plan to tomorrow's daily note

**If tomorrow's daily note doesn't exist:**
- Read `daily/TEMPLATE.md` and create `daily/YYYY-MM-DD.md` from it
- Add `## Plan` section at the top (before `## Work`)

**If tomorrow's daily note already exists:**
- Read it
- If no `## Plan` section → add it at the top
- If `## Plan` already exists → show it, propose a merge with what was discussed, confirm before overwriting

**Plan format — hybrid prose + project-grouped checkboxes:**

```markdown
## Plan

{1-2 sentence intention for the day — energy level, focus theme, key constraint}

### Personal
- [ ] {personal task, errand, appointment}

### {Project name}
- [ ] {task}
- [ ] {task}

### {Project name}
- [ ] {task}
```

Rules:
- Prose is context only — no tasks in the narrative
- Personal tasks (calls, errands, appointments) → `### Personal` checkboxes only
- Only include projects the user confirmed
- Tasks must be concrete and completable in one session
- Carry-over tasks the user commits to → include in the relevant project group
- Keep it short — plan, not spec

### Step 3.5: Confirm and close

After writing the file: "Plan written to `daily/{date}.md`. Good night."

---

## Error Handling

| Situation | Action |
|---|---|
| Daily note missing for a past day | Skip that day silently in Week Pulse |
| `goals/` directory missing | Skip Goals section in Week Pulse silently |
| `reviews/weekly/` directory missing | Treat as no reviews yet → trigger review prompt |
| Tomorrow's daily note doesn't exist | Create from `daily/TEMPLATE.md` |
| User skips review when prompted | Proceed to Phase 3, no file written |
| `goals/weekly/` empty | Skip goals grade, skip Weekly Focus in Phase 3 |
