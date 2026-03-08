/**
 * manage_event MCP tool (renamed from manage_task in Phase 06.1)
 *
 * Single tool with action parameter: get | complete | update | cancel | create.
 * Resolves events by natural language fuzzy title match — no exact path needed.
 *
 * Recurring event completion: bumps start_time, logs to ## Completions,
 * resets checklist — never sets status to done.
 *
 * Non-recurring completion: sets status to done.
 *
 * NOTE: No hard delete from MCP tools — daemon can't sync cloud→local deletions.
 * Cancelled events are filtered from list_events.
 * /vault-cleanup skill handles permanent deletion (local rm + DB orphan cleanup).
 */

import { supabase } from '../../services/supabase.js';
import { USER_ID } from '../../config.js';
import {
  isChecklistComplete,
  completeRecurringTask,
  isTimedEvent,
  type TaskFrontmatter,
} from '../../utils/task-helpers.js';
import { searchNotes } from './search.js';
import {
  makeTaskSlug,
  buildTaskFrontmatter,
  detectContext,
} from '../../utils/task-helpers.js';
import {
  isGcalEnabled,
  createGcalEvent,
  updateGcalEvent,
  deleteGcalEvent,
} from '../../services/gcal.js';
import matter from 'gray-matter';
import { createHash } from 'crypto';
import { logger } from '../../utils/logger.js';

/* -------------------------------------------------------------------------- */
/* RRULE mapping for recurring events                                          */
/* -------------------------------------------------------------------------- */

/**
 * Map a TaskFrontmatter recurring field to a GCal RRULE string.
 * Returns undefined if no recurring field set.
 */
function rruleForFrontmatter(fm: TaskFrontmatter): string | undefined {
  if (!fm.recurring) return undefined;
  const map: Record<string, string> = {
    daily:   'RRULE:FREQ=DAILY',
    weekly:  'RRULE:FREQ=WEEKLY',
    monthly: 'RRULE:FREQ=MONTHLY',
  };
  return map[fm.recurring] ?? undefined;
}

/* -------------------------------------------------------------------------- */
/* Interfaces                                                                   */
/* -------------------------------------------------------------------------- */

export interface ManageEventArgs {
  /**
   * For `create`: the event title or natural language description.
   * For all other actions: fuzzy title reference to find the existing event.
   */
  event: string;
  action: 'create' | 'get' | 'complete' | 'update' | 'cancel';
  /** UUID from a previous create/get response. When provided, skips all fuzzy matching and does a direct DB lookup. */
  id?: string;
  /** Optional note appended on completion */
  note?: string;
  /**
   * For `update`: fields to merge into frontmatter.
   * For `create`: structured event fields (priority, start_time, end_time, context, tags,
   *   urgent, important, recurring, blocked_by, checklist, body).
   */
  updates?: Partial<TaskFrontmatter> & {
    priority?: 'low' | 'normal' | 'high';
    start_time?: string;
    end_time?: string;
    context?: string;
    tags?: string[];
    urgent?: boolean;
    important?: boolean;
    recurring?: 'daily' | 'weekly' | 'monthly';
    blocked_by?: Array<{ path: string; id: string }>;
    checklist?: string[];
    body?: string;
  };
  /** Check off specific checklist item by name or 0-based index */
  checklist_item?: string | number;
}

interface EventRow {
  id: string;
  path: string;
  frontmatter: TaskFrontmatter;
  body: string;
}

/* -------------------------------------------------------------------------- */
/* Event resolution (fuzzy title match)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a natural language event reference to a single EventRow.
 *
 * Strategy:
 * 1. Case-insensitive substring match against frontmatter.title
 * 2. Word overlap scoring fallback
 * 3. searchNotes fallback (semantic search filtered to events/ prefix)
 *
 * Returns { match } on success, { error } on no/multiple matches.
 */
async function resolveEvent(
  eventRef: string,
  id?: string
): Promise<{ match: EventRow } | { error: string }> {
  // Fast-path: if id provided, skip fuzzy matching and do a direct DB lookup
  if (id) {
    const { data, error } = await supabase
      .from('files')
      .select('id, path, frontmatter, body')
      .eq('id', id)
      .eq('user_id', USER_ID)
      .single();
    if (data) return { match: data as EventRow };
    return { error: `No event found with id: "${id}"` };
  }

  // Fetch all events (non-cancelled + non-done first, then all)
  const { data, error } = await supabase
    .from('files')
    .select('id, path, frontmatter, body')
    .like('path', 'events/%')
    .eq('user_id', USER_ID);

  if (error) {
    return { error: `DB query failed: ${error.message}` };
  }

  if (!data || data.length === 0) {
    return { error: 'No events found in vault' };
  }

  const ref = eventRef.toLowerCase().trim();

  // Pass 1: exact substring match in title
  const substringMatches = data.filter((row: EventRow) =>
    (row.frontmatter?.title ?? '').toLowerCase().includes(ref)
  );

  if (substringMatches.length === 1) {
    return { match: substringMatches[0] };
  }

  if (substringMatches.length > 1) {
    const titles = substringMatches
      .map((r: EventRow) => `"${r.frontmatter?.title ?? r.path}"`)
      .join(', ');
    return {
      error: `Multiple matches for "${eventRef}": ${titles}. Please be more specific.`,
    };
  }

  // Pass 2: word overlap scoring
  const refWords = ref.split(/\s+/).filter(w => w.length > 2);

  let bestScore = 0;
  let bestMatches: EventRow[] = [];

  for (const row of data as EventRow[]) {
    const titleWords = (row.frontmatter?.title ?? '').toLowerCase().split(/\s+/);
    const overlap = refWords.filter(w => titleWords.some(tw => tw.includes(w))).length;
    const score = refWords.length > 0 ? overlap / refWords.length : 0;

    if (score > 0.5) {
      if (score > bestScore) {
        bestScore = score;
        bestMatches = [row];
      } else if (score === bestScore) {
        bestMatches.push(row);
      }
    }
  }

  if (bestMatches.length === 1) {
    return { match: bestMatches[0] };
  }

  if (bestMatches.length > 1) {
    const titles = bestMatches
      .map((r: EventRow) => `"${r.frontmatter?.title ?? r.path}"`)
      .join(', ');
    return {
      error: `Multiple matches for "${eventRef}": ${titles}. Please be more specific.`,
    };
  }

  // Pass 3: semantic search fallback via searchNotes (events/ prefix filter)
  try {
    const searchResponse = await searchNotes(eventRef, 5);
    const eventResults = searchResponse.results.filter(r => r.path.startsWith('events/'));

    if (eventResults.length === 0) {
      return { error: `No event found matching: "${eventRef}"` };
    }

    if (eventResults.length > 1) {
      // Re-fetch full rows for the found paths
      const { data: foundRows, error: fetchError } = await supabase
        .from('files')
        .select('id, path, frontmatter, body')
        .in('path', eventResults.map(r => r.path))
        .eq('user_id', USER_ID);

      if (fetchError || !foundRows || foundRows.length === 0) {
        return { error: `No event found matching: "${eventRef}"` };
      }

      if (foundRows.length === 1) {
        return { match: foundRows[0] as EventRow };
      }

      const titles = (foundRows as EventRow[])
        .map(r => `"${r.frontmatter?.title ?? r.path}"`)
        .join(', ');
      return {
        error: `Multiple matches for "${eventRef}": ${titles}. Please be more specific.`,
      };
    }

    // Single semantic match — fetch full row
    const { data: singleRow, error: singleErr } = await supabase
      .from('files')
      .select('id, path, frontmatter, body')
      .eq('path', eventResults[0].path)
      .eq('user_id', USER_ID)
      .single();

    if (singleErr || !singleRow) {
      return { error: `No event found matching: "${eventRef}"` };
    }

    return { match: singleRow as EventRow };
  } catch {
    return { error: `No event found matching: "${eventRef}"` };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Recompute content hash and update an event row in the DB.
 * Also syncs gcal_event_id and gcal_calendar columns so the poller lookup stays accurate.
 */
async function updateEventInDB(
  path: string,
  frontmatter: TaskFrontmatter,
  body: string
): Promise<void> {
  const matter = await import('gray-matter');
  const fullContent = matter.default.stringify(body, frontmatter as Record<string, unknown>);
  const content_hash = createHash('sha256').update(fullContent).digest('hex');

  const updatePayload: Record<string, unknown> = {
    frontmatter,
    body,
    content_hash,
    updated_at: new Date().toISOString(),
    // Sync dedicated columns so gcal-poller lookups by gcal_event_id stay accurate
    gcal_event_id: frontmatter.gcal_event_id ?? null,
    gcal_calendar: frontmatter.gcal_calendar ?? null,
  };

  const { error } = await supabase
    .from('files')
    .update(updatePayload)
    .eq('path', path)
    .eq('user_id', USER_ID);

  if (error) {
    throw new Error(`DB update failed: ${error.message}`);
  }
}

/**
 * Check off a single checklist item in body by name or 0-based index.
 * Returns null if the item was not found.
 */
function checkOffItem(
  body: string,
  item: string | number
): string | null {
  const lines = body.split('\n');
  const uncheckedPattern = /^(- \[ \] )(.+)$/i;

  let targetIndex: number | null = null;

  if (typeof item === 'number') {
    // Find the nth unchecked item (0-based)
    let uncheckedCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (uncheckedPattern.test(lines[i])) {
        if (uncheckedCount === item) {
          targetIndex = i;
          break;
        }
        uncheckedCount++;
      }
    }
  } else {
    // Find unchecked item with matching name (case-insensitive substring)
    const itemRef = item.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(uncheckedPattern);
      if (match && match[2].toLowerCase().includes(itemRef)) {
        targetIndex = i;
        break;
      }
    }
  }

  if (targetIndex === null) return null;

  lines[targetIndex] = lines[targetIndex].replace(/^- \[ \] /, '- [x] ');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Tool implementation                                                          */
/* -------------------------------------------------------------------------- */

export async function manageEventTool(args: ManageEventArgs) {
  const { event: eventRef, action, note, updates, checklist_item, id } = args;

  try {
    /* ---------------------------------------------------------------------- */
    /* action: create                                                           */
    /* ---------------------------------------------------------------------- */

    if (action === 'create') {
      const resolvedTitle = eventRef.trim();
      if (!resolvedTitle) {
        return { success: false, error: 'event is required for create — provide a title or natural language description' };
      }

      const u = (updates ?? {}) as any;

      // calendar is required even for untimed/backlog events — omitting it causes a YAML
      // serialization crash ("unacceptable kind of an object to dump [object Undefined]").
      // Always pass: { "updates": { "calendar": "personal" | "family" | "work" | "health" | "content" } }
      if (!u.calendar) {
        return {
          success: false,
          error: 'manage_event create requires "calendar" in updates — even for untimed/backlog events. Pass one of: personal, family, work, health, content. Example: { "updates": { "calendar": "work" } }',
        };
      }

      const bodyText = u.body || '';
      const resolvedContext = u.context || detectContext(resolvedTitle + ' ' + bodyText);

      const slug = makeTaskSlug(resolvedTitle);
      const path = `events/${slug}.md`;

      const frontmatter: TaskFrontmatter = buildTaskFrontmatter({
        title: resolvedTitle,
        priority: u.priority,
        start_time: u.start_time ?? null,
        end_time: u.end_time ?? null,
        context: resolvedContext,
        tags: u.tags,
        urgent: u.urgent,
        important: u.important,
        recurring: u.recurring,
        blocked_by: u.blocked_by,
        calendar: u.calendar,
      });

      // Handle reminder events: resolve source_file path to UUID, store flat fields
      if (u.source_file) {
        frontmatter.source_file = u.source_file;
        // Attempt to resolve source_file path to UUID via DB lookup
        const { data: sourceRow } = await supabase
          .from('files')
          .select('id')
          .eq('path', u.source_file)
          .eq('user_id', USER_ID)
          .single();
        if (sourceRow) {
          frontmatter.source_file_id = sourceRow.id;
        }
      }

      // Handle GCal-imported events: skip GCal creation, store gcal_event_id directly
      if (u.source === 'gcal') {
        frontmatter.source = 'gcal';
        if (u.gcal_event_id) frontmatter.gcal_event_id = u.gcal_event_id as string;
        if (u.gcal_calendar) frontmatter.gcal_calendar = u.gcal_calendar as string;
      } else if (isGcalEnabled() && isTimedEvent(frontmatter)) {
        // Timed event: create GCal event (strict — throw if GCal fails)
        const gcalDescription = bodyText.trim()
          ? bodyText.trim()
          : frontmatter.source_file
            ? `Review: ${resolvedTitle}\n\nVault: ${frontmatter.source_file}`
            : undefined;

        const gcalResult = await createGcalEvent({
          title: resolvedTitle,
          start_time: (frontmatter.start_time ?? frontmatter.remind_at)!,
          end_time: frontmatter.end_time ?? undefined,
          calendar: frontmatter.calendar ?? frontmatter.gcal_calendar ?? undefined,
          description: gcalDescription,
          recurrence: rruleForFrontmatter(frontmatter),
          popup_minutes: u.popup_minutes ?? undefined,
        });

        frontmatter.gcal_event_id = gcalResult.gcal_event_id;
        frontmatter.gcal_calendar = frontmatter.calendar ?? 'personal';
      } else if (!isTimedEvent(frontmatter)) {
        // Untimed event: backlog only, no GCal
        frontmatter.status = 'backlog';
      }

      let bodyParts: string[] = [];
      if (u.checklist && u.checklist.length > 0) {
        bodyParts.push(u.checklist.map((item: string) => `- [ ] ${item}`).join('\n'));
      }
      if (bodyText.trim()) {
        bodyParts.push(bodyText.trim());
      }
      const body = bodyParts.join('\n\n');

      const fullContent = matter.stringify(body, frontmatter);
      const content_hash = createHash('sha256').update(fullContent).digest('hex');

      const { data: insertedEvent, error: insertError } = await supabase
        .from('files')
        .insert({
          path,
          body,
          frontmatter,
          content_hash,
          updated_at: new Date().toISOString(),
          user_id: USER_ID,
          intelligence_status: 'complete',
          chunks_status: 'pending',
          ...(frontmatter.gcal_event_id ? { gcal_event_id: frontmatter.gcal_event_id } : {}),
          ...(frontmatter.gcal_calendar ? { gcal_calendar: frontmatter.gcal_calendar } : {}),
        })
        .select('id')
        .single();

      if (insertError) {
        throw insertError;
      }

      return {
        success: true,
        id: insertedEvent?.id,
        path,
        title: resolvedTitle,
        start_time: frontmatter.start_time ?? null,
        context: resolvedContext,
        gcal_event_id: frontmatter.gcal_event_id ?? null,
        message: `Created event: ${resolvedTitle} | context: ${resolvedContext}${frontmatter.start_time ? ` | start_time: ${frontmatter.start_time}` : ''}${frontmatter.gcal_event_id ? ` | gcal: ${frontmatter.gcal_event_id}` : ''}`,
      };
    }

    // Resolve event by fuzzy title match (or direct id lookup)
    const resolved = await resolveEvent(eventRef, id);
    if ('error' in resolved) {
      return { success: false, error: resolved.error };
    }

    const { match } = resolved;
    const { id: matchId, path, frontmatter, body } = match;

    /* ---------------------------------------------------------------------- */
    /* action: get                                                              */
    /* ---------------------------------------------------------------------- */

    if (action === 'get') {
      const unchecked = (body.match(/^- \[ \] .+/gim) || []).length;
      const checked = (body.match(/^- \[x\] .+/gim) || []).length;
      const total = unchecked + checked;

      return {
        success: true,
        id: matchId,
        path,
        frontmatter,
        body,
        checklist_progress: total > 0 ? `${checked}/${total}` : null,
      };
    }

    /* ---------------------------------------------------------------------- */
    /* action: complete                                                         */
    /* ---------------------------------------------------------------------- */

    if (action === 'complete') {
      let updatedFrontmatter = { ...frontmatter };
      let updatedBody = body;

      // Handle checklist_item first (check off a specific item)
      if (checklist_item !== undefined) {
        const newBody = checkOffItem(body, checklist_item);
        if (newBody === null) {
          return {
            success: false,
            error: `Checklist item not found: "${checklist_item}"`,
          };
        }
        updatedBody = newBody;

        // After checking off, test if checklist is fully complete
        if (isChecklistComplete(updatedBody)) {
          if (frontmatter.recurring) {
            // Recurring: log completion, bump start_time, reset checklist
            const result = await completeRecurringTask(
              supabase,
              path,
              USER_ID,
              updatedFrontmatter,
              updatedBody,
              note,
              matchId
            );
            // Recurring completion: move GCal event to next occurrence (not delete)
            if (isGcalEnabled() && frontmatter.gcal_event_id) {
              try {
                await updateGcalEvent(
                  frontmatter.gcal_event_id,
                  frontmatter.gcal_calendar ?? undefined,
                  { start_time: result.newRemindAt }
                );
              } catch (gcalErr: any) {
                logger.warn({ gcal_event_id: frontmatter.gcal_event_id, err: gcalErr?.message }, 'GCal update failed on checklist recurring completion (non-critical)');
              }
            }
            return {
              success: true,
              id: matchId,
              path,
              title: frontmatter.title,
              action: 'recurring_completed',
              new_start_time: result.newRemindAt,
              message: `Completed recurring event: ${frontmatter.title} | next start_time: ${result.newRemindAt}`,
              follow_up: 'Any note? (optional)',
            };
          } else {
            // Non-recurring: set status to done
            updatedFrontmatter.status = 'done';
            const completedAt = new Date().toISOString();
            updatedFrontmatter.completed_at = completedAt;
            if (note) {
              updatedBody = updatedBody.trimEnd() + `\n\n---\n${note}\n`;
            }
            await updateEventInDB(path, updatedFrontmatter, updatedBody);
            // GCal event intentionally left in place — completed events stay as historical record
            return {
              success: true,
              id: matchId,
              path,
              title: frontmatter.title,
              action: 'completed',
              completed_at: completedAt,
              message: `Completed event: ${frontmatter.title}`,
              follow_up: 'Any note? (optional)',
            };
          }
        } else {
          // Checklist not fully done yet — just save the checked-off item
          await updateEventInDB(path, updatedFrontmatter, updatedBody);
          const newChecked = (updatedBody.match(/^- \[x\] .+/gim) || []).length;
          const newUnchecked = (updatedBody.match(/^- \[ \] .+/gim) || []).length;
          const newTotal = newChecked + newUnchecked;
          return {
            success: true,
            id: matchId,
            path,
            title: frontmatter.title,
            action: 'checklist_item_checked',
            checklist_progress: `${newChecked}/${newTotal}`,
            message: `Checked off item in: ${frontmatter.title} (${newChecked}/${newTotal} done)`,
          };
        }
      }

      // Full event completion (no specific checklist_item)
      if (frontmatter.recurring) {
        // Recurring: log completion, bump start_time, reset checklist
        const result = await completeRecurringTask(
          supabase,
          path,
          USER_ID,
          updatedFrontmatter,
          updatedBody,
          note,
          matchId
        );

        // Recurring completion: move GCal event to next occurrence (not delete)
        if (isGcalEnabled() && frontmatter.gcal_event_id) {
          try {
            await updateGcalEvent(
              frontmatter.gcal_event_id,
              frontmatter.gcal_calendar ?? undefined,
              { start_time: result.newRemindAt }
            );
          } catch (gcalErr: any) {
            logger.warn({ gcal_event_id: frontmatter.gcal_event_id, err: gcalErr?.message }, 'GCal update failed on recurring completion (non-critical)');
          }
        }

        return {
          success: true,
          id: matchId,
          path,
          title: frontmatter.title,
          action: 'recurring_completed',
          new_start_time: result.newRemindAt,
          message: `Completed recurring event: ${frontmatter.title} | next start_time: ${result.newRemindAt}`,
          follow_up: 'Any note? (optional)',
        };
      } else {
        // Non-recurring: set status to done
        updatedFrontmatter.status = 'done';
        const completedAt = new Date().toISOString();
        updatedFrontmatter.completed_at = completedAt;

        if (note) {
          updatedBody = updatedBody.trimEnd() + `\n\n---\n${note}\n`;
        }

        await updateEventInDB(path, updatedFrontmatter, updatedBody);
        // GCal event intentionally left in place — completed events stay as historical record

        return {
          success: true,
          id: matchId,
          path,
          title: frontmatter.title,
          action: 'completed',
          completed_at: completedAt,
          message: `Completed event: ${frontmatter.title}`,
          follow_up: 'Any note? (optional)',
        };
      }
    }

    /* ---------------------------------------------------------------------- */
    /* action: update                                                           */
    /* ---------------------------------------------------------------------- */

    if (action === 'update') {
      if (!updates || Object.keys(updates).length === 0) {
        return { success: false, error: 'No updates provided' };
      }

      const updatedFrontmatter: TaskFrontmatter = { ...frontmatter, ...updates };
      let updatedBody = body;

      // If body content changed via updates, apply it
      if ((updates as any).body !== undefined) {
        updatedBody = (updates as any).body;
      }

      // GCal update: check if time, body, or calendar fields changed
      const startTimeChanged = updates.start_time !== undefined && updates.start_time !== frontmatter.start_time;
      const endTimeChanged = updates.end_time !== undefined && updates.end_time !== frontmatter.end_time;
      const bodyChanged = (updates as any).body !== undefined && (updates as any).body !== body;

      // Detect calendar change: either `calendar` or `gcal_calendar` field may carry the new value
      const newCalendarName = (updates as any).calendar ?? (updates as any).gcal_calendar;
      const oldCalendarName = frontmatter.gcal_calendar ?? frontmatter.calendar ?? 'personal';
      const calendarMoved = newCalendarName !== undefined && newCalendarName !== oldCalendarName;

      let gcalWarning: string | undefined;

      if (isGcalEnabled()) {
        if (calendarMoved && frontmatter.gcal_event_id) {
          // Calendar move: delete from old calendar, create in new, update gcal_event_id.
          // Delete may 404 if event was already moved/deleted in GCal — silently ignored.
          try {
            await deleteGcalEvent(frontmatter.gcal_event_id, oldCalendarName);
            const gcalResult = await createGcalEvent({
              title: updatedFrontmatter.title,
              start_time: (updatedFrontmatter.start_time ?? updatedFrontmatter.remind_at)!,
              end_time: updatedFrontmatter.end_time ?? undefined,
              calendar: newCalendarName,
              description: updatedBody.trim() || undefined,
              recurrence: rruleForFrontmatter(updatedFrontmatter),
            });
            updatedFrontmatter.gcal_event_id = gcalResult.gcal_event_id;
            updatedFrontmatter.gcal_calendar = newCalendarName;
            updatedFrontmatter.calendar = newCalendarName;
            logger.info(
              { old: oldCalendarName, new: newCalendarName, gcal_event_id: gcalResult.gcal_event_id },
              'GCal event moved to new calendar'
            );
          } catch (gcalErr: any) {
            gcalWarning = `GCal calendar move failed: ${gcalErr?.message}`;
            logger.warn({ gcal_event_id: frontmatter.gcal_event_id, err: gcalErr?.message }, 'GCal calendar move failed (non-critical)');
          }
        } else if (startTimeChanged || endTimeChanged || bodyChanged) {
          if (frontmatter.gcal_event_id) {
            // Event already has GCal event — update it
            try {
              await updateGcalEvent(
                frontmatter.gcal_event_id,
                updatedFrontmatter.gcal_calendar ?? undefined,
                {
                  start_time: updatedFrontmatter.start_time ?? undefined,
                  end_time: updatedFrontmatter.end_time ?? undefined,
                  description: bodyChanged ? updatedBody : undefined,
                }
              );
            } catch (gcalErr: any) {
              logger.warn({ gcal_event_id: frontmatter.gcal_event_id, err: gcalErr?.message }, 'GCal update failed on time change (non-critical)');
            }
          } else if (isTimedEvent(updatedFrontmatter)) {
            // Event was untimed, now getting a time — create GCal event
            try {
              const gcalResult = await createGcalEvent({
                title: updatedFrontmatter.title,
                start_time: (updatedFrontmatter.start_time ?? updatedFrontmatter.remind_at)!,
                end_time: updatedFrontmatter.end_time ?? undefined,
                calendar: updatedFrontmatter.calendar ?? updatedFrontmatter.gcal_calendar ?? undefined,
                recurrence: rruleForFrontmatter(updatedFrontmatter),
              });
              updatedFrontmatter.gcal_event_id = gcalResult.gcal_event_id;
              updatedFrontmatter.gcal_calendar = updatedFrontmatter.calendar ?? 'personal';
            } catch (gcalErr: any) {
              logger.warn({ err: gcalErr?.message }, 'GCal create failed on update (non-critical)');
            }
          }
        }
      }

      await updateEventInDB(path, updatedFrontmatter, updatedBody);

      // Re-enqueue for chunking if body changed
      if ((updates as any).body !== undefined) {
        await supabase.rpc('enqueue_file_for_chunking', {
          p_file_id: match.id,
          p_clear_existing_chunks: true,
        });
      }

      return {
        success: true,
        id: matchId,
        path,
        title: updatedFrontmatter.title,
        action: 'updated',
        updated_fields: Object.keys(updates),
        gcal_event_id: updatedFrontmatter.gcal_event_id ?? null,
        ...(gcalWarning ? { gcal_warning: gcalWarning } : {}),
        message: `Updated event: ${updatedFrontmatter.title} (${Object.keys(updates).join(', ')})`,
      };
    }

    /* ---------------------------------------------------------------------- */
    /* action: cancel                                                           */
    /* ---------------------------------------------------------------------- */

    if (action === 'cancel') {
      // Delete GCal event first — strict, must succeed to avoid resurrection by poller
      if (isGcalEnabled() && frontmatter.gcal_event_id) {
        await deleteGcalEvent(frontmatter.gcal_event_id, frontmatter.gcal_calendar ?? undefined);
      }

      // Hard DELETE from Supabase — daemon syncs deletion to local filesystem
      const { error: deleteError } = await supabase
        .from('files')
        .delete()
        .eq('path', path)
        .eq('user_id', USER_ID);

      if (deleteError) {
        throw new Error(`DB delete failed: ${deleteError.message}`);
      }

      return {
        success: true,
        id: matchId,
        path,
        title: frontmatter.title,
        action: 'cancelled',
        message: `Cancelled and deleted event: ${frontmatter.title}`,
      };
    }

    return { success: false, error: `Unknown action: ${action}` };
  } catch (error: any) {
    return {
      success: false,
      error: `manage_event failed: ${error.message}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* MCP tool definition                                                          */
/* -------------------------------------------------------------------------- */

export const manageEventToolDef = {
  name: 'manage_event',
  description:
    'Create, get, complete, update, or cancel an event. For create: event is the title/description, pass structured fields via updates (start_time, end_time, priority, etc.). For all other actions: resolves by fuzzy title match — no exact path needed. Recurring events log completion and bump start_time without setting status to done.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      event: {
        type: 'string' as const,
        description:
          'For create: event title or natural language description. For other actions: partial title is enough (e.g. "call dentist" matches "Call the dentist")',
      },
      id: {
        type: 'string' as const,
        description:
          'UUID from a previous create/get response. When provided, skips all fuzzy matching and does a direct DB lookup.',
      },
      action: {
        type: 'string' as const,
        enum: ['create', 'get', 'complete', 'update', 'cancel'] as const,
        description:
          'create: insert new event | get: return full event details | complete: mark done (or bump recurring) | update: merge fields into frontmatter | cancel: set status to cancelled',
      },
      note: {
        type: 'string' as const,
        description: 'Optional completion note. Appended to event body on complete.',
      },
      updates: {
        type: 'object' as const,
        description:
          'For create: structured event fields (priority, start_time, end_time, context, tags, urgent, important, recurring, blocked_by, checklist, body). For update: fields to merge into frontmatter (e.g. { "priority": "high", "start_time": "2026-03-01T15:00:00Z" })',
        properties: {
          title: { type: 'string' as const, description: 'Event title' },
          status: { type: 'string' as const, description: 'Event status (upcoming, done, cancelled, backlog)' },
          priority: { type: 'string' as const, description: 'Priority level (low, normal, high)' },
          start_time: { type: 'string' as const, description: 'ISO 8601 start time — triggers GCal event creation' },
          end_time: { type: 'string' as const, description: 'ISO 8601 end time (optional — creates time block with start_time)' },
          context: { type: 'string' as const, description: 'Event context category' },
          tags: { type: 'array' as const, items: { type: 'string' as const }, description: 'Event tags' },
          urgent: { type: 'boolean' as const, description: 'Urgent flag' },
          important: { type: 'boolean' as const, description: 'Important flag' },
          recurring: { type: 'string' as const, description: 'Recurring frequency (daily, weekly, monthly)' },
          blocked_by: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                path: { type: 'string' as const, description: 'Path to blocking event file' },
                id: { type: 'string' as const, description: 'UUID of blocking event' },
              },
            },
            description: 'Events that block this one',
          },
          checklist: { type: 'array' as const, items: { type: 'string' as const }, description: 'Checklist items' },
          body: { type: 'string' as const, description: 'Event body content' },
          popup_minutes: { type: 'number' as const, description: 'Minutes before start_time to fire a GCal popup notification (default: 0 = at start time)' },
        },
        additionalProperties: true,
      },
      checklist_item: {
        type: ['string', 'number'] as const,
        description:
          'Check off a specific checklist item by name (partial match) or 0-based index. When last item is checked, event is auto-completed (or recurring cycle bumped).',
      },
    },
    required: ['event', 'action'] as const,
  },
};
