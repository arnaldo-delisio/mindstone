/**
 * Recurring Date Arithmetic
 *
 * Computes the next occurrence of a recurring task's remind_at,
 * preserving the time-of-day component across daily/weekly/monthly cycles.
 *
 * Pattern from RESEARCH.md Pattern 5.
 */

import { addDays, addWeeks, addMonths, parseISO } from 'date-fns';

/**
 * Compute the next remind_at for a recurring task.
 *
 * Time component is preserved automatically — addDays/addWeeks/addMonths
 * do not modify hours/minutes/seconds.
 *
 * @param remindAt  - ISO 8601 string from DB (e.g. "2026-02-28T15:00:00.000Z")
 * @param recurring - Recurrence interval
 * @returns ISO 8601 string for the next occurrence
 *
 * @example
 * nextOccurrence('2026-02-28T09:00:00.000Z', 'daily')   // '2026-03-01T09:00:00.000Z'
 * nextOccurrence('2026-02-28T09:00:00.000Z', 'weekly')  // '2026-03-07T09:00:00.000Z'
 * nextOccurrence('2026-02-28T09:00:00.000Z', 'monthly') // '2026-03-28T09:00:00.000Z'
 */
export function nextOccurrence(
  remindAt: string,
  recurring: 'daily' | 'weekly' | 'monthly'
): string {
  const current = parseISO(remindAt);

  const next =
    recurring === 'daily'
      ? addDays(current, 1)
      : recurring === 'weekly'
        ? addWeeks(current, 1)
        : addMonths(current, 1);

  return next.toISOString();
}
