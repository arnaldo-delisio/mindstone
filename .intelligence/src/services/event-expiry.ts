/**
 * event-expiry.ts — Auto-complete past vault events
 *
 * Runs hourly via node-cron.
 * Marks events as 'done' when their time has passed:
 *   - If end_time exists: mark done when end_time < now()
 *   - If no end_time: fall back to start_time < now()
 *
 * Applies to all vault events regardless of source.
 */

import cron from 'node-cron';
import { createHash } from 'crypto';
import matter from 'gray-matter';
import { supabase } from './supabase.js';
import { USER_ID } from '../config.js';
import { logger } from '../utils/logger.js';
import { completeRecurringTask, type TaskFrontmatter } from '../utils/task-helpers.js';

export function startEventExpiryCron(): void {
  logger.info('Starting event expiry cron (hourly)');

  cron.schedule('0 * * * *', async () => {
    try {
      await expirePastEvents();
    } catch (err) {
      logger.error({ err }, 'Event expiry cron error');
    }
  });
}

async function expirePastEvents(): Promise<void> {
  const now = new Date().toISOString();

  // Fetch upcoming events with end_time in the past
  const { data: expiredByEnd, error: e1 } = await supabase
    .from('files')
    .select('id, path, frontmatter, body')
    .like('path', 'events/%')
    .eq('user_id', USER_ID)
    .filter('frontmatter->>status', 'eq', 'upcoming')
    .not('frontmatter->>end_time', 'is', null)
    .filter('frontmatter->>end_time', 'lt', now);

  // Fetch upcoming events with no end_time but start_time in the past
  const { data: expiredByStart, error: e2 } = await supabase
    .from('files')
    .select('id, path, frontmatter, body')
    .like('path', 'events/%')
    .eq('user_id', USER_ID)
    .filter('frontmatter->>status', 'eq', 'upcoming')
    .is('frontmatter->>end_time', null)
    .not('frontmatter->>start_time', 'is', null)
    .filter('frontmatter->>start_time', 'lt', now);

  if (e1 || e2) {
    logger.error({ e1, e2 }, 'Event expiry: query errors');
    return;
  }

  const toExpire = [...(expiredByEnd ?? []), ...(expiredByStart ?? [])];

  if (toExpire.length === 0) {
    logger.debug('Event expiry: no past events to expire');
    return;
  }

  let completed = 0;
  let bumped = 0;

  for (const event of toExpire) {
    const fm = event.frontmatter as TaskFrontmatter;
    const body = event.body ?? '';
    const path = event.path as string;

    try {
      if (fm.recurring) {
        // Recurring: bump to next occurrence, log completion, reset checklist
        await completeRecurringTask(supabase, path, USER_ID, fm, body);
        bumped++;
      } else {
        // Non-recurring: mark done and recompute content hash
        const updatedFm = { ...fm, status: 'done', completed_at: new Date().toISOString() };
        const fullContent = matter.stringify(body, updatedFm);
        const content_hash = createHash('sha256').update(fullContent).digest('hex');

        const { error } = await supabase
          .from('files')
          .update({ frontmatter: updatedFm, content_hash, updated_at: new Date().toISOString() })
          .eq('id', event.id)
          .eq('user_id', USER_ID);

        if (error) {
          logger.error({ error, id: event.id, path }, 'Event expiry: failed to update event');
        } else {
          completed++;
        }
      }
    } catch (err) {
      logger.error({ err, id: event.id, path }, 'Event expiry: error processing event');
    }
  }

  logger.info({ completed, bumped }, 'Event expiry: processed past events');
}
