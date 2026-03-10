---
name: goals
description: View and edit personal goals across annual, quarterly, and weekly horizons. Warns if weekly goals are stale. /goals:review shows longitudinal history across all cycles.
invocation_pattern: /goals or /goals:review
auto_invoked: false
---

# Goals Skill

View and edit goals across all three horizons. Warns when weekly goals are stale. Longitudinal review available via `/goals:review`.

---

## Phase 0: Vault Detection

Glob for `goals/` directory at vault root. If missing:

```
Goals system not initialized. Set it up now?
```

If yes → create directories `goals/annual/`, `goals/quarterly/`, `goals/weekly/` then proceed to new-file flow for all three horizons (annual first, quarterly second, weekly third — show each as context for the next).

If no → stop.

---

## Phase 1: Load Goals

Run in parallel:

- Glob `goals/annual/*.md` → sort descending by filename → read the first (current year)
- Glob `goals/quarterly/*.md` → sort descending → read the first (current quarter)
- Glob `goals/weekly/*.md` → sort descending → read the first (current week)

**Staleness check:** Get creation date from frontmatter of the most recent weekly file. If 7+ days ago → set `weekly_stale = true`.

**New period detection (run in parallel):**
- Current year: `YYYY`. If no `goals/annual/YYYY.md` exists → `annual_missing = true`
- Current quarter: `YYYY-QN`. If no matching file → `quarterly_missing = true`
- Current ISO week: `YYYY-WNN`. If no matching file → `weekly_missing = true`

---

## Phase 2: Display

### `/goals` (default)

Show all three horizons in full:

```
# Goals

## Annual (2026)
[full body of annual file]

## Quarterly (Q1 2026)
[full body of quarterly file]

## Weekly (W10)
[full body of weekly file]
```

After displaying, surface flags one at a time:

- `weekly_stale` → "⚠️ Weekly goals haven't been updated in N days — want to update them?"
- `annual_missing` → "No annual goals set for YYYY — want to set them now?"
- `quarterly_missing` → "No quarterly goals for QN — want to set them now?"
- `weekly_missing` → "No weekly goals for WNN — want to set them now?"

If user says yes to any → run Phase 3 (Edit) for that horizon.

### `/goals:review`

Longitudinal view across all cycles.

**Weekly timeline:**
Read all files in `goals/weekly/` and all files in `reviews/weekly/`. Cross-reference by date to build a table:

```
## Weekly History

W07  theme: ship week          targets: 3  hit: 1/3  ✅⬛⬛
W08  theme: infrastructure     targets: 3  hit: 2/3  ✅✅⬛
W09  theme: ship week          targets: 3  hit: 3/3  ✅✅✅
W10  theme: (current)          targets: 3  —
```

Hit rate sourced from `goals_hit` frontmatter in `reviews/weekly/YYYY-MM-DD.md`. If no matching review for that week → show `—`.

**Quarterly summary:**
Read all files in `goals/quarterly/` and `reviews/quarterly/`. For each quarter, show commitments from the goals file and outcomes from the matching review file (if it exists).

**Annual summary:**
Read all files in `goals/annual/` and `reviews/annual/` chronologically. Show each year's directions alongside the matching annual review (if it exists).

After displaying: "Anything to update?" → conversational edit via Phase 3.

---

## Phase 3: Edit (Conversational)

User describes the change in natural language. Examples:
- "Update weekly theme to infrastructure week"
- "Add a quarterly goal: ship MindStone Phase 1"
- "Start Q2 goals"
- "Mark the [project] annual milestone done"

**For updates to existing files:**
1. Read the target file
2. Make the surgical edit using Edit tool — never rewrite the whole file
3. Confirm: "Updated [horizon] goals."

**For new period files:**
Show the higher horizon as context before prompting:
- Creating quarterly → show annual first: "Your 2026 annual goals are: [X, Y, Z]. What are your Q2 commitments?"
- Creating weekly → show quarterly first: "Your Q1 commitments are: [X, Y, Z]. What are your targets for W11?"

New files are created with Write tool using the formats below.

---

## File Formats

**Annual** — `goals/annual/YYYY.md`
```markdown
---
year: YYYY
type: annual-goals
created: YYYY-MM-DD
---

## [Area / Direction title]
[1-2 sentence direction — where you want to be by year end]
- milestone or outcome
- milestone or outcome

## [Second area]
[direction]
- milestone
```

**Quarterly** — `goals/quarterly/YYYY-QN.md`
```markdown
---
quarter: YYYY-QN
type: quarterly-goals
created: YYYY-MM-DD
---

## Commitments
- commitment 1
- commitment 2
- commitment 3

## Context
[optional: how this quarter serves annual direction]
```

**Weekly** — `goals/weekly/YYYY-WNN.md`
```markdown
---
week: YYYY-WNN
type: weekly-goals
created: YYYY-MM-DD
theme: [one-line theme]
---

## Theme
[one sentence]

## Targets
- [ ] target 1
- [ ] target 2
- [ ] target 3
```

---

## Error Handling

| Situation | Action |
|---|---|
| `goals/` directory missing | Offer to initialize |
| No file for current period | Prompt to create — show higher horizon as context |
| Weekly file is stale | Warn after display, offer to update |
| No `reviews/weekly/` directory in `/goals:review` | Show weekly history without hit rates |
