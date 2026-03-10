# library/research/

Notes on research papers, academic articles, and long-form technical writing.

## Naming Convention

Use the paper or article slug: `attention-is-all-you-need.md`, `dynamo-amazon.md`

## What Goes Here

Key ideas, methodology, findings, and your own interpretation of research papers and articles. The intelligence pipeline can process these to surface connections with other notes.

## Frontmatter

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `learning` |
| `title` | string | yes | paper or article title |
| `date` | date | yes | date you read it |
| `tags` | array | yes | topic tags |
| `source` | string | yes | always `article` |
| `url` | string | no | link to paper |
| `author` | string | no | author(s) |
| `intelligence_status` | string | yes | `pending` until pipeline runs |
