/**
 * Reminder Scanner — Cron (Phase 06.1 updated)
 *
 * Phase 06.1: Resend email reminders replaced by GCal popup notifications.
 * Events with start_time fire GCal popup at start_time — no email dispatch needed.
 *
 * scanAndSendReminders() is now a no-op stub.
 * checkAndSendMorningBriefing() removed (replaced by get_calendar_events).
 * checkAndSendJournalReminder() stub — will be rewritten in Plan 06 to create
 * a GCal recurring event instead of email.
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';
import { USER_ID } from '../config.js';
import { logger } from '../utils/logger.js';

/* -------------------------------------------------------------------------- */
/* Journal reminder config                                                     */
/* -------------------------------------------------------------------------- */

// JOURNAL_REMINDER_TIME: "HH:MM" in 24h format (default "21:00")
const JOURNAL_REMINDER_TIME = process.env.JOURNAL_REMINDER_TIME || '21:00';

// In-memory guard: tracks date when journal reminder was last sent
let lastJournalReminderDate: string | null = null;

// In-memory flag: track if we've already created the recurring GCal event this process lifetime
let eveningReminderGcalCreated = false;

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface ScanResult {
  scanned: number;
  sent: number;
  failed: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Start the reminder cron job.
 * Phase 06.1: scanAndSendReminders is now a no-op. Morning briefing removed.
 * Only checkAndSendJournalReminder runs on the 15-minute tick.
 * Fire-and-forget — does not return a Promise.
 */
export function startReminderCron(): void {
  logger.info('Starting reminder cron (every 15 minutes)');

  cron.schedule('*/15 * * * *', async () => {
    const start = Date.now();
    logger.debug('Reminder cron tick');

    // Journal reminder check
    try {
      await checkAndSendJournalReminder();
    } catch (err) {
      logger.error({ err }, 'Journal reminder cron error');
    }

    const duration = Date.now() - start;
    logger.debug({ durationMs: duration }, 'Reminder cron tick complete');
  });
}

/**
 * Check if it is evening journal reminder time and, if so, ensure the GCal recurring event exists.
 * Only fires if today's journal entry lacks sleep_hours (not yet logged).
 * Safe to call on every 15-minute tick — in-memory guard prevents duplicate sends.
 * GCal recurring event created once (first time this fires) — recurs automatically after that.
 */
export async function checkAndSendJournalReminder(): Promise<void> {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  // Already sent today?
  if (lastJournalReminderDate === todayStr) return;

  // Check time window (21:00 default)
  const [reminderHour, reminderMinute] = JOURNAL_REMINDER_TIME.split(':').map(Number);
  const reminderMinutesFromMidnight = reminderHour * 60 + reminderMinute;
  const nowMinutesFromMidnight = now.getHours() * 60 + now.getMinutes();

  if (
    nowMinutesFromMidnight < reminderMinutesFromMidnight ||
    nowMinutesFromMidnight >= reminderMinutesFromMidnight + 15
  ) return;

  // Check if today's journal entry is "real" (sleep_hours non-null)
  const journalPath = `journal/${todayStr}.md`;
  const { data: journalFile } = await supabase
    .from('files')
    .select('frontmatter')
    .eq('path', journalPath)
    .eq('user_id', USER_ID)
    .maybeSingle();

  if (journalFile?.frontmatter?.sleep_hours != null) return; // already logged

  lastJournalReminderDate = todayStr;
  logger.info({ todayStr, reminderTime: JOURNAL_REMINDER_TIME }, 'Journal reminder time — ensuring GCal recurring event exists');

  // Create the recurring GCal event once (if not already created in this process lifetime)
  // The event is a daily recurring event at JOURNAL_REMINDER_TIME on the Health calendar.
  // We only need to create it once — it recurs automatically after that.
  if (!eveningReminderGcalCreated) {
    try {
      const { isGcalEnabled, createGcalEvent } = await import('./gcal.js');
      if (isGcalEnabled()) {
        // Check if a "Log your day" event already exists in vault events/
        const { data: existingEvent } = await supabase
          .from('files')
          .select('id')
          .like('path', 'events/%')
          .eq('user_id', USER_ID)
          .ilike('frontmatter->>title', '%log your day%')
          .maybeSingle();

        if (!existingEvent) {
          // Create recurring daily GCal event at JOURNAL_REMINDER_TIME in your configured timezone
          const [h, m] = JOURNAL_REMINDER_TIME.split(':').map(Number);
          const startDt = new Date();
          startDt.setHours(h, m, 0, 0);
          const endDt = new Date(startDt.getTime() + 15 * 60 * 1000);

          const result = await createGcalEvent({
            title: 'Log your day',
            start_time: startDt.toISOString(),
            end_time: endDt.toISOString(),
            calendar: 'health',
            description: 'Open /doctor to log your day — sleep, meals, habits.',
            popup_minutes: 0,
            recurrence: 'RRULE:FREQ=DAILY',
          });

          // Store as a vault event so it's not recreated on next deploy
          const { makeTaskSlug } = await import('../utils/task-helpers.js');
          const slug = makeTaskSlug('log your day');
          const { createHash } = await import('crypto');
          const m2 = await import('gray-matter');
          const fm = {
            title: 'Log your day',
            status: 'upcoming',
            calendar: 'health',
            gcal_event_id: result.gcal_event_id,
            gcal_calendar: 'health',
            recurring: 'daily',
            created: todayStr,
          };
          const body = 'Open /doctor to log your day — sleep, meals, habits.';
          const fullContent = m2.default.stringify(body, fm);
          await supabase.from('files').insert({
            path: `events/${slug}.md`,
            frontmatter: fm,
            body,
            content_hash: createHash('sha256').update(fullContent).digest('hex'),
            user_id: USER_ID,
            intelligence_status: 'complete',
            chunks_status: 'pending',
            updated_at: new Date().toISOString(),
          });

          logger.info({ gcal_event_id: result.gcal_event_id }, 'Evening journal reminder: GCal recurring event created');
        }

        eveningReminderGcalCreated = true;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to create evening reminder GCal event');
    }
  }
}

/**
 * Scan for due reminders and dispatch notifications.
 * Phase 06.1: No-op stub — Resend email reminders replaced by GCal popup notifications.
 * Events with start_time fire GCal popup at start_time — no email dispatch needed.
 */
export async function scanAndSendReminders(): Promise<ScanResult> {
  // Phase 06.1: Resend email reminders replaced by GCal popup notifications
  // Events with start_time fire GCal popup at start_time — no email dispatch needed
  logger.debug('scanAndSendReminders: no-op (replaced by GCal notifications in Phase 06.1)');
  return { scanned: 0, sent: 0, failed: 0 };
}
