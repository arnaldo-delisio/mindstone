# journal/

Daily health journal entries — written during `/doctor` sessions.

## Naming Convention

`YYYY-MM-DD.md` — e.g. `2026-01-15.md`

## What Goes Here

One file per journaling session with the Doctor persona. Each entry captures sleep, meals, habits, and open-ended session notes. The Doctor reads the last 7 entries at the start of each session to maintain continuity.

## Frontmatter

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `journal` |
| `date` | date | yes | session date |
| `sleep_hours` | number | no | hours of sleep previous night |
| `bowel` | number | no | Bristol stool scale (1-7) |
| `meals` | array | no | list of meals |
| `habits` | array | no | habits tracked that day |
| `intelligence_status` | string | yes | `pending` until pipeline runs |
