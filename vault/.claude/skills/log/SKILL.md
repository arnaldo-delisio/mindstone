---
name: log
description: Quickly log entries to vault daily notes with automatic timestamping and categorization. Use when user wants to capture work sessions, ideas, learnings, or content notes.
---

# Vault Log

Append timestamped, categorized notes to today's daily journal (`daily/YYYY-MM-DD.md`).

## Context

Daily notes follow a structured format with three categories:
- **Work**: Sessions, tasks, accomplishments
- **Learning**: Insights, discoveries, knowledge captured
- **Ideas**: Future projects, experiments, thoughts

The system automatically:
- Creates today's file if it doesn't exist
- Detects category from content keywords
- Adds proper timestamp (HH:MM format)
- Maintains section structure
- Tracks Claude Code session IDs in frontmatter

## Workflow

### Step 0: Session Summary Mode (Default)

When `/log` is invoked **without explicit content** (or user says "log the session", "log what we did"):

1. **Review the full conversation context** to identify what was accomplished
2. **Get timestamp and read today's daily note** (in parallel)
3. **Auto-detect categories** — session may produce both Work and Learning entries
4. **Check for consolidation** (see Consolidation Rule below) — same project + within 1-2 hours = update existing entry instead of adding a new one
5. **Draft a comprehensive entry** (100-300 words) matching user's narrative style

6. **MANDATORY: Scan and update plan checkboxes (separate Edit)**
   > ⚠️ This step is REQUIRED and must never be skipped, even if nothing seems to match.
   - Read the `## Plan` section of today's daily note
   - Go through every `- [ ]` item one by one against the conversation
   - Clearly completed → `- [x] item`
   - Deferred/moved/cancelled → `- [ ] ~~item~~ → reason`
   - Ambiguous or unrelated → leave untouched
   - Do NOT touch items already checked or already struck through
   - Apply as a **dedicated Edit** (separate from the entry Edit)

7. **MANDATORY: Complete matching backlog events via `manage_event`**
   > ⚠️ This step is REQUIRED and must never be skipped.
   - Call `list_events({ filter: 'all' })` to get current backlog
   - Cross-reference every backlog event title against the conversation
   - For each event that was clearly completed in the session, call `manage_event complete` with a brief note
   - Skip events that are ambiguous or only partially done
   - Do this in parallel with or just before the entry Edit — do NOT ask the user first

8. **Apply the work entry Edit** — add/update the Work section entry

This is the most common usage. The user expects: checkboxes Edit + event completions + entry Edit. Do NOT ask "what do you want to log?" or show a preview first — just execute all steps.

### Step 1: Get User Input (Explicit Content Mode)

When user provides specific content with the command. Examples:
- "Log: Fixed authentication bug in login flow"
- "Log work: Completed Phase 3.4 planning session"
- "Log idea: Build automated content pipeline"
- "Log learning: Discovered LangChain chunking approach"

### Step 2: Prepare Entry

**A. Get current time, date, and session ID:**
```bash
date +"%Y-%m-%d"  # For filename: daily/2026-02-16.md
date +"%H:%M"     # For timestamp: 14:35
tail -1 ~/.claude/history.jsonl | jq -r '.sessionId'  # Get current session ID
```

**Note:** Session ID extraction may fail if `jq` is not installed or history.jsonl is empty. In that case, skip session tracking gracefully.

**After-midnight convention:** If the current time is between 00:00 and ~05:00 and the work belongs to the previous day's session, log it in yesterday's daily note using an extended clock: add 24 to the hour. Examples: `00:30 → 24:30`, `01:12 → 25:12`, `02:45 → 26:45`. Keeps entries sortable and unambiguous within the day's context.

**B. Auto-detect category from content:**
- **Work**: task, completed, fixed, implemented, session, planning, phase, executed, updated
- **Learning**: learned, discovered, insight, found, understanding, explored
- **Ideas**: idea, experiment, future, could, should, maybe, build

Default to "Work" if no clear match.

**C. Extract title (first sentence or ~50 chars) and description (rest of content)**

### Step 3: Update Daily File

**A. Check if file exists:**
```bash
ls daily/YYYY-MM-DD.md
```

**If file doesn't exist, create it with Write tool:**
```markdown
---
tags:
  - daily
claude_sessions:
  [project-name]:
    - [session-id]
token_count: 0
---
# YYYY-MM-DD

## Work

## Learning

## Ideas
```

**If file exists, check and update session tracking:**
1. Read the file to get existing frontmatter
2. Parse `claude_sessions` map from frontmatter
3. Determine the current project name (from cwd, PLAN.md, or conversation context)
4. If project key doesn't exist, add it with current session ID as first item
5. If project key exists but session ID is not in its list, append the session ID
6. Update frontmatter before appending entry

**B. Read the existing file** (to preserve existing content)

**C. Add new entry to appropriate category section:**

Format:
```
**HH:MM - Title**

Description text here.
```

**D. Use Edit tool to append entry:**
- Find the category section (e.g., `## Work`)
- Append entry after the section heading (before next section)
- Preserve all existing content

### Step 4: Confirm to User

After logging, confirm with a simple message:
```
✓ Logged to daily/2026-02-16.md at 14:35 in Work section
```

## Usage Examples

**Quick log (auto-category):**
```
User: "log: completed statusline customization"
→ Auto-detects category: Work
→ Gets timestamp: 14:35
→ Title: "Statusline Customization Complete"
→ Edits daily/2026-02-16.md, appends to ## Work section
```

**Explicit category:**
```
User: "log idea: create vault stats dashboard"
→ Category specified: Ideas
→ Gets timestamp: 15:20
→ Title: "Vault Stats Dashboard"
→ Edits daily/2026-02-16.md, appends to ## Ideas section
```

**Detailed entry:**
```
User: "log: Created vault-log skill. Added direct file editing for daily notes. Auto-categorization working."
→ Auto-detects: Work
→ Title: "Vault-Log Skill Created"
→ Description: Full paragraph with technical details
→ Appends formatted entry to ## Work section
```

## Implementation Details

**File Operations Flow:**

1. **Get timestamp and session ID:**
   ```bash
   date +"%Y-%m-%d"  # 2026-02-16
   date +"%H:%M"     # 14:35
   tail -1 ~/.claude/history.jsonl | jq -r '.sessionId'  # Current session
   ```

2. **Check if daily file exists:**
   - If yes: Read file to preserve content
   - If no: Create with template structure (includes session ID in frontmatter)

3. **Update session tracking (if file exists):**
   - Parse `claude_sessions` array from frontmatter
   - If current session ID not in array, add it using Edit tool
   - Gracefully handle missing `jq` or parse errors

4. **Auto-detect category:**
   - Scan content for keywords
   - Default to "Work" if unclear

5. **Format entry:**
   ```markdown
   **14:35 - Entry Title**

   Entry description paragraph here.
   ```

6. **Scan and update plan checkboxes (FIRST Edit):**
   - Read `## Plan` section, check every `- [ ]` item against the conversation
   - Apply ticks/strikethroughs as a dedicated Edit

7. **Complete matching backlog events:**
   - Call `list_events({ filter: 'all' })`, cross-reference against conversation
   - Call `manage_event complete` for each clearly-completed event
   - Run in parallel with step 8

8. **Insert entry (SECOND Edit):**
   - Use Edit tool to find category section (e.g., `## Work`)
   - Append new entry after section heading
   - Preserve all existing content

**Key Implementation Notes:**
- Always read file first (to preserve existing entries)
- Checkbox scan is MANDATORY — even if nothing matches, you must check
- Event completion check is MANDATORY — even if nothing matches, you must check
- Three actions per session log: (1) checkboxes Edit, (2) event completions, (3) entry Edit — never skip any
- Insert new entries in **chronological order** by timestamp within the section — not always at the bottom
- Use Edit tool to insert/update (never overwrite the whole file)
- Add blank line after entry for spacing
- Category sections already exist in template
- Track session IDs in frontmatter `claude_sessions` array
- Gracefully handle session ID extraction failures (skip if `jq` missing)

## Consolidation Rule

Before creating a new entry, scan existing entries in today's daily note for a related one. **Consolidate (update the existing entry) instead of adding a new one** when:

- Same project/topic, AND
- Existing entry timestamp is within ~2 hours of the new entry's timestamp

**How to consolidate:**
- Keep the earlier timestamp in the title
- Expand the description to include the new work — weave it in naturally as continuation, not as a tacked-on paragraph
- The result should read as one coherent entry, not two glued together

**When to always create a new entry (do NOT consolidate):**
- Different project/topic
- More than ~2 hours apart
- User explicitly says "new entry" or "separate entry"
- The new work is a meaningfully different context shift (e.g., debugging → new feature planning)

## Format Guidelines

Entries are timestamped with bold titles:
```
**HH:MM - Title**

Description text here.
```

**Entry length:** 2-4 sentences. Enough to recall what happened, not a full report.

**Entry format:**
- Specific titles: project/feature name + what changed (e.g. "Phase 1 Extraction Complete")
- 2-4 sentences covering what was built, key technical decisions, current status
- No bullet points — prose only
- No references to GSD, plans, waves, or internal workflow tooling — describe the actual work done

## Category Detection Keywords

The tool auto-detects categories based on content:
- **Work**: task, completed, fixed, implemented, session, planning
- **Learning**: learned, discovered, insight, found, understanding
- **Ideas**: idea, experiment, future, could, should, maybe

## Tips

**Based on user's actual daily notes:**
- Titles: project name + what changed, not generic "Work Session"
- 2-4 sentences: what was built, key decisions, current status
- Prose only — no bullet points
- No references to internal workflow tooling (GSD, plans, waves, phases by number) — describe the actual work
- Focus on outcomes, not process

## Session Tracking

Each daily note tracks which Claude Code sessions contributed to it via the `claude_sessions` map in frontmatter. The key is the **project name**, the value is a list of session UUIDs:

```yaml
---
tags:
  - daily
claude_sessions:
  [project-name]:
    - 191a0764-0192-4275-b28d-396be2c28f78
    - 550e8400-e29b-41d4-a716-446655440000
token_count: 147
---
```

**Why this structure:**
- One lookup by project name → all session UUIDs → all JSONL files at `~/.claude/projects/`
- Each UUID maps to a full conversation transcript that I can grep to restore context
- No scanning through all entries to filter by project — project is the key

**Implementation:**
- Session ID extracted from `~/.claude/history.jsonl` using `jq`
- Project name inferred from cwd, active PLAN.md, or conversation context
- Automatically added to frontmatter when logging entries
- Fails gracefully if `jq` not installed or history unavailable
- Multiple sessions per project per day accumulate as a list under the project key

## Integration with Vault

Daily notes sync automatically via `.daemon` to Supabase:
- Written directly to `daily/YYYY-MM-DD.md` (vault root relative)
- Synced to Supabase by vault-sync service
- Available on mobile via Claude MCP
- Searchable with `mcp__vault__search_notes`
- Version controlled in git
- No MCP tool needed for writing (direct file operations)

## Common Use Cases

**Feature implementation:**
```
log: Vault chunking now uses RecursiveCharacterTextSplitter — re-chunked 125 files into 387 token-sized chunks, fixed queue processor bug. Embeddings pipeline stable.
```

**System fix:**
```
log: Fixed OOM crashes with sequential processing — intelligence runs first, triggers embeddings via DB trigger. Gemini now skips regenerating existing metadata (saves ~40% daily quota).
```

**Setup/tooling:**
```
log: Ferdium set up with WhatsApp, Instagram DMs, LinkedIn. Wrote JS redirect to keep Instagram locked to inbox. LinkedIn Google OAuth blocked in Electron — switched to email+password login.
```

**Quick entries:**
```
log: Completed statusline customization with colors and progress bar
log idea: Build vault analytics dashboard showing growth over time
log learning: Skills auto-load when placed in .claude/skills/
```

## Safety Notes

- Daily files are gitignored (content only in Supabase + local)
- Entries are appended (never destructive)
- Timestamps prevent duplicate detection issues
- Category sections created automatically if missing
