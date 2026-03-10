# reviews/quarterly/

Quarterly review notes — written at the end of each quarter during a `/shutdown` or `/goals` session.

## Naming Convention

`YYYY-QN.md` — e.g. `2026-Q1.md`

## What Goes Here

A deeper review covering the quarter: goals hit, patterns observed, and plan adjustments for next quarter. Written by Claude during the quarterly review flow. You do not write these manually.

## Frontmatter

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `date` | date | yes | review date |
| `period_start` | date | yes | first day of quarter |
| `period_end` | date | yes | last day of quarter |
| `goals_hit` | string | no | e.g. `8/12` |
| `type` | string | yes | always `review` |
| `tags` | array | yes | always `[review]` |
