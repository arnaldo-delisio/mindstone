# library/books/

Notes and highlights from books you've read.

## Naming Convention

Use the book's slug: `the-pragmatic-programmer.md`, `deep-work.md`

## What Goes Here

One file per book. Capture key takeaways, highlights, and your own synthesis. The intelligence pipeline will process these files to extract learnings and generate embeddings.

## Frontmatter

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `learning` |
| `title` | string | yes | book title |
| `date` | date | yes | date you read/finished it |
| `tags` | array | yes | topic tags |
| `source` | string | yes | always `book` |
| `author` | string | no | author name(s) |
| `intelligence_status` | string | yes | `pending` until pipeline runs |
