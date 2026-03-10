/**
 * event-expiry.ts — No-op by design
 *
 * Auto-expiry was intentionally removed: time passing ≠ task done.
 * Past upcoming events are surfaced in /brief and /shutdown for explicit
 * user confirmation before being marked done.
 */

export function startEventExpiryCron(): void {
  // No-op — event reconciliation is handled by /brief and /shutdown skills
}
