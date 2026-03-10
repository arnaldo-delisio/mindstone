# reviews/annual/

Annual review notes — written at year-end during a `/goals` or `/shutdown` session.

## Naming Convention

`YYYY.md` — e.g. `2026.md`

## What Goes Here

A comprehensive year-end review: major achievements, themes, goal completion, and intentions for next year. Written by Claude during the annual review flow. You do not write these manually.

## Frontmatter

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `date` | date | yes | review date |
| `period_start` | date | yes | first day of year |
| `period_end` | date | yes | last day of year |
| `goals_hit` | string | no | e.g. `15/20` |
| `type` | string | yes | always `review` |
| `tags` | array | yes | always `[review]` |
