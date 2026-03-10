# library/youtube/

Notes from YouTube videos — lectures, talks, tutorials, and long-form content.

## Naming Convention

Use a descriptive slug: `feynman-technique-explained.md`, `bret-victor-inventing-on-principle.md`

## What Goes Here

Key insights, timestamps of important moments, and your synthesis from videos. Use `/extract` to automatically extract and save content from YouTube URLs.

## Frontmatter

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `learning` |
| `title` | string | yes | video title |
| `date` | date | yes | date you watched it |
| `tags` | array | yes | topic tags |
| `source` | string | yes | always `youtube` |
| `url` | string | no | YouTube URL |
| `author` | string | no | channel name |
| `intelligence_status` | string | yes | `pending` until pipeline runs |
