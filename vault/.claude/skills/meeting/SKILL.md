---
name: meeting
description: Create a meeting transcript file in library/meetings/. Collects title, date, project, participants — then creates the structured file so you can paste the transcript directly into it.
---

# Meeting

Create a structured meeting file in `library/meetings/[project]/` ready for transcript paste.

## Workflow

### Step 1: Collect metadata

Ask (all in one message, 3 questions):

1. **Meeting** — title (e.g. "Alessia weekly", "Founder check-in")
2. **Project** — which project/context? (type a project name)
3. **Participants** — who was in the meeting? (comma-separated names)

Date defaults to today unless user specifies otherwise (e.g. "yesterday's meeting with Alessia").

### Step 2: Resolve GCal event ID

Scan local `events/*.md` files for events on the meeting date:

```
Glob events/*.md
```

For each file, read the frontmatter and check if `start_time` matches the meeting date (YYYY-MM-DD prefix).

- **One match** → use its `gcal_event_id` silently
- **Multiple matches** → show titles, ask which one (or "none")
- **No matches** → skip, leave `gcal_event_id` out of frontmatter

### Step 3: Build file path

```
library/meetings/[project]/YYYY-MM-DD-[slug].md
```

Slug: lowercase title, spaces→hyphens, strip special chars. Max 40 chars.

Examples:
- `library/meetings/[project-a]/2026-02-26-weekly-sync.md`
- `library/meetings/[project-b]/2026-02-26-founder-check-in.md`

Create directory if it doesn't exist (Write tool handles this automatically).

### Step 4: Write file

Use Write tool to create the file:

```markdown
---
type: meeting
date: YYYY-MM-DD
project: [project]
participants: [name1, name2]
gcal_event_id: [id if resolved]
duration_min:
---

```

Leave body empty — user will paste transcript directly.

`duration_min` is always included as empty field — user can fill it or leave blank.
Only include `gcal_event_id` line if resolved.

### Step 5: Confirm

```
Meeting file ready:

  library/meetings/[project]/YYYY-MM-DD-[slug].md

Open the file and paste your transcript below the frontmatter.
The intelligence pipeline will tag and embed it automatically.
```
