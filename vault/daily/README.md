# daily/

Daily notes — one file per day.

## Naming Convention

`YYYY-MM-DD.md` — e.g. `2026-01-15.md`

## What Goes Here

Each daily note tracks what you worked on, learned, and thought about during the day. Claude creates or opens today's note automatically during `/brief` and appends to it with `/log`.

## Sections

- **Work** — tasks completed, code written, meetings attended
- **Learning** — insights, concepts, or skills practiced
- **Ideas** — raw thoughts, things to explore later

## Frontmatter

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `tags` | array | yes | always `[daily]` |
| `claude_sessions` | array | no | populated by Claude during sessions |
| `token_count` | number | no | updated by intelligence pipeline |

## Template

Use `TEMPLATE.md` as the base for new daily notes.
