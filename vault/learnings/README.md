# learnings/

Distilled insights — standalone notes capturing a single idea, concept, or technique.

## Naming Convention

Use a descriptive slug: `how-tcp-ip-works.md`, `postgres-index-types.md`

## What Goes Here

Short, standalone notes capturing something you learned that doesn't belong to a specific book, video, or article. Good for insights from conversations, experiments, or reading scattered sources.

Unlike `library/`, these aren't tied to a single source — they're your own synthesis.

## Frontmatter

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `learning` |
| `title` | string | yes | concise title for the insight |
| `date` | date | yes | date learned |
| `tags` | array | yes | topic tags |
| `source` | string | no | optional source category |
| `url` | string | no | optional source URL |
| `author` | string | no | optional |
| `intelligence_status` | string | yes | `pending` until pipeline runs |
