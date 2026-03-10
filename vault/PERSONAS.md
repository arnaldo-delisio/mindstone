# Personas

Personas are specialized AI roles that give Claude deep domain expertise, consistent behavior, and a structured workflow for a specific domain of your life.

## What is a Persona?

A persona is a markdown file in `.personas/` that gives Claude:
- A role identity and expertise framing
- Session opening and closing rituals
- A structured first-session intake flow (optional but powerful)
- Rules for managing domain-specific state files
- Domain-specific file operations and tool usage

Skills invoke personas by reading the persona file at session start. The Doctor persona, for example, is invoked by the `/doctor` skill, which calls the `doctor` MCP tool. The tool loads `doctor.md`, `health/STATE.md`, and the last 7 journal entries in a single call, then returns everything Claude needs to run the session.

## The Doctor Persona — A Reference Design

`.personas/doctor.md` is the reference implementation. Here's what makes it work:

### Identity and Framing

The identity section establishes Claude's role, tone, and behavioral constraints for every session. The Doctor persona defines:
- **Role:** Doctor and psychologist — physical and psychological health integrated
- **Tone:** Socratic and direct, not cheerleader-style. Names patterns plainly: "You've slept under 6 hours 4 days in a row. That matters."
- **Constraints:** Health domain only. Reads `journal/` and `health/STATE.md`. Does not cross into `daily/` notes.

A well-written identity section prevents drift. Without explicit tone and scope, Claude will default to generic assistant behavior within sessions.

### Session Opening Ritual

Every session starts with the same ritual: load state, scan the last 7 days, surface a pattern overview. The ritual matters because:
1. It grounds Claude in current data before the user says a word
2. It sets a consistent expectation — the user knows what to expect each time
3. It separates "new session" from "re-entry today" behavior, preventing redundant recaps

The Doctor persona explicitly prohibits skipping the ritual: "Even if the user dives straight into a topic, surface the pattern overview first."

### First Session Intake (Phases A–E)

The first-session intake is triggered automatically when `health/STATE.md` is missing. It runs 15–20 questions across five phases before generating any files:

- **Phase A:** Universal opener — goals, current routine, 6-month vision
- **Phase B:** Adaptive tunneling — medical baseline, diet, injury history, sleep, stress, substance use
- **Phase C:** Research agent — spawn a Task agent to research conditions and habits before continuing
- **Phase D:** Post-research questions — validate hypotheses, fill gaps the research surfaced, confirm habit set
- **Phase E:** Generate documents — write `health/STATE.md`, first journal entry, offer habit reminders as events

The research agent step (Phase C) is a differentiator: Claude pauses intake to consult evidence before asking Phase D questions, producing sharper and more personalized recommendations than a purely conversational intake.

**Never generate `health/STATE.md` until all phases complete.** Generating it early locks in an incomplete profile.

### State File

`health/STATE.md` persists between sessions. It stores: profile, current goals, confirmed habits (with streaks), calibrated baselines, doctor-observed patterns, and a next session proposal.

Key rule: always read current state first, merge changes in, never replace wholesale. This preserves multi-session pattern observations that would be lost by overwriting.

### Journal Format

Each session produces a journal entry at `journal/YYYY-MM-DD.md`. YAML frontmatter captures structured metrics (sleep hours, bowel score, meals list, habits list) alongside free-text body sections (Body, Mind, Notes).

Structured frontmatter is what enables querying: "how many days this month did you hit all habits?" requires machine-readable data, not prose. The Doctor persona captures specifics aggressively — "spaghetti carbonara" not "pasta", exact sleep hours not "okay" — to maximize data quality.

## Building a Custom Persona

To create a new persona, create `.personas/{name}.md` with these sections:

### 1. Identity

Describe the role, expertise, tone, and scope:
- What domain does this persona cover? (Health, finance, learning, etc.)
- What tone should Claude adopt? (Socratic, direct, encouraging, analytical)
- What are the hard scope limits? (What files does it read? What topics does it stay in?)

### 2. Session Opening

Define what Claude loads and presents at the start of every session:
- Which state files to read
- Which recent files to scan (last N entries, last N days)
- What summary to surface before asking the user anything
- What triggers a "re-entry" vs "new session" behavior

### 3. First Session Intake (optional)

For domains where baseline data matters, define a structured intake flow:
- What questions to ask before generating any files
- What research or analysis to run mid-intake (if any)
- What documents to generate at the end

Skip this section for simpler personas where no persistent state is needed.

### 4. Session Closing

Define what Claude writes at the end of a session:
- Which files to update (state file, journal, etc.)
- What triggers a close (farewell phrases, natural pause, explicit request)
- What to confirm to the user ("Today's entry is saved")

### 5. State File (optional)

Define the structure of the persistent state file:
- Location and naming convention
- Sections and what goes in each
- Update rules (merge vs replace, what changes when)

### 6. File Operations

Specify the file conventions for this persona's domain:
- File paths and naming conventions
- Frontmatter fields (required and optional)
- Body structure

### 7. MCP Tools Available

List which MCP tools the persona uses and when:
- `manage_note` — reading and writing domain files
- `manage_event` — creating reminders or appointments
- `search_notes` — cross-domain knowledge lookup

## Naming Convention

`.personas/{name}.md` — lowercase, hyphen-separated for multi-word names.

Invocation via a skill named `/{name}`. The skill reads the persona file and loads any required state, typically via a dedicated MCP tool (e.g., `doctor` tool loads the Doctor persona + state in one call).

## Tips

- Keep personas under 400 lines — clarity and reliability degrade above this threshold
- One persona per domain (health, finance, learning) — multi-domain personas lose their grounding
- State files use plain markdown sections, not JSON — Claude reads and writes markdown naturally
- First session intakes build the state file collaboratively — better than one big form upfront
- Name patterns directly in the identity section ("You missed N days — anything going on?") — this prevents Claude from softening into generic assistant behavior
- The session opening ritual is the most important section — it sets the entire session tone
