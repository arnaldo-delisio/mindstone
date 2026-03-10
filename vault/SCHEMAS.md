# Vault Frontmatter Schemas

Central reference for all content-type frontmatter schemas.

---

## Daily Notes

**Location:** `daily/YYYY-MM-DD.md`

```yaml
---
tags:
  - daily
claude_sessions: []
token_count: 0
---
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `tags` | array | yes | always `[daily]` |
| `claude_sessions` | array | no | populated by Claude during sessions |
| `token_count` | number | no | updated by intelligence pipeline |

---

## Library (All Types)

**Location:** `library/{books,repos,research,youtube}/*.md`

```yaml
---
type: learning
title: "Title of the source"
date: 2026-01-01
tags:
  - topic
source: book
url: ""
author: ""
intelligence_status: pending
---
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `learning` |
| `title` | string | yes | title of the source |
| `date` | date | yes | date read/watched |
| `tags` | array | yes | topic tags |
| `source` | string | yes | `book`, `repo`, `article`, or `youtube` |
| `url` | string | no | source URL |
| `author` | string | no | author or channel name |
| `intelligence_status` | string | yes | `pending` \| `complete` \| `error` |

---

## Learnings

**Location:** `learnings/*.md`

```yaml
---
type: learning
title: "Insight title"
date: 2026-01-01
tags:
  - topic
source: article
url: ""
author: ""
intelligence_status: pending
---
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `learning` |
| `title` | string | yes | concise insight title |
| `date` | date | yes | date learned |
| `tags` | array | yes | topic tags |
| `source` | string | no | optional source category |
| `url` | string | no | optional source URL |
| `author` | string | no | optional |
| `intelligence_status` | string | yes | `pending` \| `complete` \| `error` |

---

## Journal Entries

**Location:** `journal/YYYY-MM-DD.md`

```yaml
---
type: journal
date: 2026-01-01
sleep_hours: 7.5
bowel: 4
meals: []
habits: []
intelligence_status: pending
---
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `journal` |
| `date` | date | yes | entry date |
| `sleep_hours` | number | no | hours slept previous night |
| `bowel` | number | no | Bristol stool scale 1-7 |
| `meals` | array | no | list of meals |
| `habits` | array | no | habits tracked |
| `intelligence_status` | string | yes | `pending` \| `complete` \| `error` |

---

## Events — Timed

**Location:** `events/*.md` (with start_time)

```yaml
---
type: event
title: "Event title"
start_time: "2026-01-01T14:00:00"
end_time: "2026-01-01T15:00:00"
calendar: work
status: upcoming
urgent: false
important: true
gcal_event_id: ""
recurring: false
---
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `event` |
| `title` | string | yes | event title |
| `start_time` | datetime | yes | ISO 8601 format |
| `end_time` | datetime | no | ISO 8601 format |
| `calendar` | string | no | calendar name from calendars.json |
| `status` | string | yes | `upcoming` \| `done` \| `cancelled` |
| `urgent` | boolean | no | Eisenhower matrix |
| `important` | boolean | no | Eisenhower matrix |
| `gcal_event_id` | string | no | populated by sync daemon |
| `recurring` | boolean | no | true if recurring event |

---

## Events — Untimed / Backlog

**Location:** `events/*.md` (without start_time)

```yaml
---
type: event
title: "Task or intention"
status: upcoming
urgent: true
important: false
---
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `event` |
| `title` | string | yes | task or intention title |
| `status` | string | yes | `upcoming` \| `done` \| `cancelled` |
| `urgent` | boolean | no | Eisenhower matrix |
| `important` | boolean | no | Eisenhower matrix |

---

## Goals — Annual

**Location:** `goals/annual/YYYY.md`

```yaml
---
year: 2026
type: annual-goals
created: 2026-01-01
---
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `year` | number | yes | the year (e.g. `2026`) |
| `type` | string | yes | always `annual-goals` |
| `created` | date | yes | date goals were set |

---

## Goals — Quarterly

**Location:** `goals/quarterly/YYYY-QN.md`

```yaml
---
quarter: 2026-Q1
type: quarterly-goals
created: 2026-01-01
---
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `quarter` | string | yes | e.g. `2026-Q1` |
| `type` | string | yes | always `quarterly-goals` |
| `created` | date | yes | date goals were set |

---

## Goals — Weekly

**Location:** `goals/weekly/YYYY-WNN.md`

```yaml
---
week: 2026-W01
type: weekly-goals
created: 2026-01-01
theme: "Optional theme"
---
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `week` | string | yes | ISO week e.g. `2026-W01` |
| `type` | string | yes | always `weekly-goals` |
| `created` | date | yes | date goals were set |
| `theme` | string | no | optional one-phrase theme |

---

## Weekly Reviews

**Location:** `reviews/weekly/YYYY-MM-DD.md`

```yaml
---
date: 2026-01-07
period_start: 2026-01-01
period_end: 2026-01-07
goals_hit: "3/5"
type: review
tags:
  - review
---
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `date` | date | yes | date review was written |
| `period_start` | date | yes | first day of week covered |
| `period_end` | date | yes | last day of week covered |
| `goals_hit` | string | no | e.g. `3/5` goals achieved |
| `type` | string | yes | always `review` |
| `tags` | array | yes | always `[review]` |
