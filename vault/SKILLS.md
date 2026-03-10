---
tags:
  - productivity
  - tools
  - workflow-automation
  - knowledge-capture
  - goal-tracking
---

# Vault Skills

Custom Claude Code skills for vault management and workflows.

## Core Skills

| Skill | Invocation | Description | File |
|---|---|---|---|
| brief | `/brief` | Morning briefing — today's plan, schedule, and backlog | `.claude/skills/brief/SKILL.md` |
| shutdown | `/shutdown` | End-of-day ritual — close today, week pulse, plan tomorrow | `.claude/skills/shutdown/SKILL.md` |
| log | `/log` | Log timestamped entries to today's daily note | `.claude/skills/log/SKILL.md` |
| doctor | `/doctor` | Health journaling session with Doctor persona | `.claude/skills/doctor/SKILL.md` |
| meeting | `/meeting` | Create a meeting transcript file ready for paste | `.claude/skills/meeting/SKILL.md` |
| goals | `/goals` or `/goals:review` | View and edit goals across annual/quarterly/weekly horizons | `.claude/skills/goals/SKILL.md` |
| setup | `/setup` | First-time vault setup and configuration walkthrough | `.claude/skills/setup/SKILL.md` |

---

## Skill Reference

### /brief

**Purpose:** Morning briefing — surfaces today's schedule, upcoming events, and backlog

**What it does:**
- Reads today's `## Plan` from the daily note (written by `/shutdown` the night before)
- Fetches today's GCal events and backlog (up to 8 items)
- Suggests first action via Eisenhower inference
- Offers to print the full Eisenhower matrix on request
- If no plan found: warns and offers to run a quick inline planning session

**How to use:** `/brief`

---

### /shutdown

**Purpose:** End-of-day ritual — three phases: close today → week pulse → plan tomorrow

**What it does:**
- Phase 1 (Close Today): reads today's daily note, prompts to complete/cancel past upcoming events, asks for anything unlogged
- Phase 2 (Week Pulse): rolling 7-day view with carry-overs, weekly goals grade, review trigger if 7+ days since last review
- Phase 3 (Plan Tomorrow): pulls tomorrow's GCal events, backlog, and active GSD phases; discusses conversationally; writes hybrid prose + project-grouped checklist

**How to use:** `/shutdown`

---

### /log

**Purpose:** Quickly log entries to vault daily notes with automatic timestamping and categorization

**What it does:**
- Default (session summary): reviews conversation, drafts Work/Learning entries, scans plan checkboxes, completes backlog events
- Explicit mode: log a specific entry with optional category prefix (work/idea/learning)
- Creates today's daily note if it doesn't exist
- Tracks Claude session IDs in frontmatter

**How to use:** `/log` or `/log: [content]` or `/log idea: [content]`

---

### /doctor

**Purpose:** Health journaling and tracking with Doctor/Psychologist persona

**What it does:**
- Calls the `doctor` MCP tool to load persona, health STATE, and last 7 journal entries
- Runs a health session: mood, sleep, habits, meals, reflections
- Writes journal entry to `journal/YYYY-MM-DD.md` automatically
- Triggers First Session Intake if no health state found

**How to use:** `/doctor`

---

### /meeting

**Purpose:** Create a structured meeting transcript file ready for paste

**What it does:**
- Collects title, date, project, participants
- Scans `events/` via Glob to auto-resolve `gcal_event_id` from the matching calendar event
- Creates `library/meetings/[project]/YYYY-MM-DD-title.md` with frontmatter
- User pastes transcript directly — intelligence pipeline handles the rest

**How to use:** `/meeting`

---

### /goals

**Purpose:** View and edit personal goals across annual, quarterly, and weekly horizons

**What it does:**
- Displays all three horizons (annual, quarterly, weekly) in one view
- Warns if weekly goals haven't been updated in 7+ days
- Conversational editing: describe the change, Claude makes the surgical edit
- Auto-detects missing period files and prompts to create them with higher horizon as context
- `/goals:review` — longitudinal history: weekly hit rate table, quarterly summaries, annual evolution

**Storage:** `goals/annual/YYYY.md`, `goals/quarterly/YYYY-QN.md`, `goals/weekly/YYYY-WNN.md`

**How to use:** `/goals` or `/goals:review`

---

### /setup

**Purpose:** First-time vault setup and configuration walkthrough

**What it does:**
- Guides through initial vault configuration (environment, integrations, persona setup)
- Creates required directories and template files
- Verifies MCP tool connectivity

**How to use:** `/setup`

---

## Skill Development Guidelines

**When to create a skill:**
- Repeated workflow that benefits from automation
- Complex multi-step process
- Integrates multiple tools/systems
- Needs consistent execution pattern

**When NOT to create a skill:**
- One-time operation (use direct commands)
- Simple single-tool usage
- Already covered by existing tools

**Skill structure:**
```
.claude/skills/
└── skill-name/
    └── SKILL.md            # Required: YAML frontmatter + instructions
        ├── scripts/        # Optional: Executable code (Python/Bash)
        ├── references/     # Optional: Documentation for context
        └── assets/         # Optional: Templates, icons, files
```

**SKILL.md format:**
```markdown
---
name: skill-name
description: When to use this skill (200 chars max)
---
# Skill Name
[Instructions for Claude to follow...]
```

---

## Prompt Engineering Checklist (for generation skills)

Apply these when a skill instructs Claude to **generate content** (not just orchestrate a workflow).

### 1. Dynamic voice injection — use `!cat`, not hardcoded profiles
```
!`cat content/{{channel}}/CHANNEL.md`
```
Reads the live file at runtime. Voice corrections, new fields, and updates are always picked up automatically. Never hardcode voice descriptions inline.

### 2. XML tag separation — mandatory when mixing content types
```xml
<voice_profile>[CHANNEL.md contents]</voice_profile>
<source_material>[learning or note being used]</source_material>
<examples>
  <example>[real approved post]</example>
</examples>
<task>[generation instruction]</task>
```
Without tags, Claude conflates voice profile with source content. Quality drops unpredictably.

### 3. Data before instructions — always
Order: voice profile → source material → examples → task.
Putting the task first reduces quality ~30%. Claude forms an output plan before reading context.

### 4. Exact count enforcement
Use `"Generate EXACTLY N pieces — no more, no fewer"`.
Soft language (`"about N"`, `"around N"`) treats count as a suggestion.

### 5. Multishot examples are required for voice consistency
Voice descriptions alone cause drift — Claude approximates. 2-3 real approved posts in `## Example Content` of CHANNEL.md anchor generation to the actual voice. For new channels with no examples, warn the user and generate anyway.

### 6. Keep SKILL.md under 500 lines
Past 500 lines, instruction-following degrades. Move platform-specific generation prompts to a `prompts/` subdirectory:
```
skill-name/
├── SKILL.md          # Mode detection, orchestration (<500 lines)
├── prompts/
│   ├── twitter.md    # Twitter-specific generation prompt
│   └── linkedin.md   # LinkedIn-specific generation prompt
└── handlers.js       # Reusable logic
```
