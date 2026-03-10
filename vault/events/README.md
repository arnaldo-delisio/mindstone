# events/

Timed events (synced to Google Calendar) and untimed backlog items.

## Naming Convention

Use a descriptive slug: `team-sync-2026-01-15.md`, `book-dentist-appointment.md`

## What Goes Here

Two types of events live here:

**Timed events** — have a scheduled start and end time. These sync bidirectionally with Google Calendar. Include `start_time`, `end_time`, `calendar`, and `gcal_event_id`.

**Untimed events (backlog)** — tasks or intentions without a specific time. No `start_time` field. These appear in your `/brief` backlog view.

## Frontmatter

See `example-timed-event.md` and `example-untimed-event.md` for the two schemas.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | always `event` |
| `title` | string | yes | event title |
| `start_time` | datetime | timed only | ISO 8601 format |
| `end_time` | datetime | timed only | ISO 8601 format |
| `calendar` | string | timed only | calendar name from calendars.json |
| `status` | string | yes | `upcoming`, `done`, `cancelled` |
| `urgent` | boolean | no | Eisenhower matrix |
| `important` | boolean | no | Eisenhower matrix |
| `gcal_event_id` | string | timed only | populated by sync daemon |
| `recurring` | boolean | timed only | true if recurring event |
