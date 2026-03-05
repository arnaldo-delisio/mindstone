/**
 * plan_meal MCP tool
 *
 * Atomic operation: writes meal plan to journal/YYYY-MM-DD.md frontmatter
 * AND creates/updates GCal events on Family calendar.
 *
 * 3 events per day: breakfast, lunch, dinner — in your configured timezone (VAULT_TIMEZONE).
 * Times configurable in health/STATE.md under "## Meal Times".
 *
 * Existing GCal meal events updated in-place (no delete+recreate).
 * GCal event IDs stored in journal frontmatter as meal_gcal_ids.
 */

import { supabase } from '../../services/supabase.js';
import { USER_ID } from '../../config.js';
import { createGcalEvent, updateGcalEvent, isGcalEnabled, VAULT_TIMEZONE } from '../../services/gcal.js';
import { createHash } from 'crypto';
import matter from 'gray-matter';

export interface PlanMealArgs {
  date: string;           // YYYY-MM-DD
  breakfast: string;      // dish name
  lunch: string;
  dinner: string;
  notes?: string;         // optional meal notes appended to body
}

const DEFAULT_MEAL_TIMES = { breakfast: '08:00', lunch: '14:00', dinner: '19:00' };

async function getMealTimesFromState(): Promise<typeof DEFAULT_MEAL_TIMES> {
  const { data } = await supabase
    .from('files')
    .select('body')
    .eq('path', 'health/STATE.md')
    .eq('user_id', USER_ID)
    .maybeSingle();

  if (!data?.body) return DEFAULT_MEAL_TIMES;

  // Parse "## Meal Times" section: lines like "- breakfast: 07:30"
  const match = data.body.match(/## Meal Times\n([\s\S]*?)(?=\n## |\n*$)/);
  if (!match) return DEFAULT_MEAL_TIMES;

  const times = { ...DEFAULT_MEAL_TIMES };
  for (const line of match[1].split('\n')) {
    const [key, val] = line.replace(/^[-*]\s*/, '').split(':').map((s: string) => s.trim());
    if (key && val && key in times) {
      (times as any)[key] = val;
    }
  }
  return times;
}

export async function planMealTool(args: PlanMealArgs): Promise<string> {
  try {
    const { date, breakfast, lunch, dinner, notes } = args;
    const journalPath = `journal/${date}.md`;
    const mealTimes = await getMealTimesFromState();

    // Load or initialize journal entry
    const { data: existing } = await supabase
      .from('files')
      .select('id, frontmatter, body')
      .eq('path', journalPath)
      .eq('user_id', USER_ID)
      .maybeSingle();

    const currentFm = (existing?.frontmatter ?? {}) as Record<string, unknown>;
    const currentBody = existing?.body ?? '';
    const existingMealIds = (currentFm.meal_gcal_ids ?? {}) as Record<string, string>;

    const meals = [
      { slot: 'breakfast', dish: breakfast, time: mealTimes.breakfast },
      { slot: 'lunch',     dish: lunch,     time: mealTimes.lunch },
      { slot: 'dinner',    dish: dinner,    time: mealTimes.dinner },
    ];

    const newMealIds: Record<string, string> = { ...existingMealIds };

    // Create or update GCal events for each meal
    if (isGcalEnabled()) {
      for (const meal of meals) {
        // Parse time as local time in the configured vault timezone
        const startDt = new Date(`${date}T${meal.time}:00`);
        const endDt = new Date(startDt.getTime() + 30 * 60 * 1000); // 30-min meal event

        const existingId = existingMealIds[meal.slot];

        if (existingId) {
          // Update in-place — fall back to create if event was deleted in GCal (404)
          try {
            await updateGcalEvent(existingId, 'family', {
              title: meal.dish,
              start_time: startDt.toISOString(),
              end_time: endDt.toISOString(),
            });
          } catch (err: any) {
            if (err?.status === 404 || err?.code === 404) {
              // Stale ID — GCal event was deleted, create a fresh one
              const result = await createGcalEvent({
                title: meal.dish,
                start_time: startDt.toISOString(),
                end_time: endDt.toISOString(),
                calendar: 'family',
                popup_minutes: 0,
              });
              newMealIds[meal.slot] = result.gcal_event_id;
            } else {
              throw err;
            }
          }
        } else {
          // Create new
          const result = await createGcalEvent({
            title: meal.dish,
            start_time: startDt.toISOString(),
            end_time: endDt.toISOString(),
            calendar: 'family',
            popup_minutes: 0,
          });
          newMealIds[meal.slot] = result.gcal_event_id;
        }
      }
    }

    // Update journal frontmatter
    const updatedFm: Record<string, unknown> = {
      ...currentFm,
      date,
      meals: [breakfast, lunch, dinner],
      meal_gcal_ids: newMealIds,
    };

    // Update or append meal plan section in body
    const mealSection = `## Meal Plan\n- Breakfast: ${breakfast}\n- Lunch: ${lunch}\n- Dinner: ${dinner}${notes ? `\n\n${notes}` : ''}`;
    let updatedBody = currentBody;
    if (updatedBody.includes('## Meal Plan')) {
      updatedBody = updatedBody.replace(/## Meal Plan[\s\S]*?(?=\n## |\n*$)/, mealSection);
    } else {
      updatedBody = updatedBody.trimEnd() + (updatedBody ? '\n\n' : '') + mealSection + '\n';
    }

    const fullContent = matter.stringify(updatedBody, updatedFm);
    const content_hash = createHash('sha256').update(fullContent).digest('hex');

    if (existing) {
      await supabase
        .from('files')
        .update({ frontmatter: updatedFm, body: updatedBody, content_hash, updated_at: new Date().toISOString() })
        .eq('path', journalPath)
        .eq('user_id', USER_ID);
    } else {
      await supabase
        .from('files')
        .insert({ path: journalPath, frontmatter: updatedFm, body: updatedBody, content_hash, user_id: USER_ID, intelligence_status: 'complete', chunks_status: 'pending', updated_at: new Date().toISOString() });
    }

    return JSON.stringify({
      success: true,
      date,
      meals: { breakfast, lunch, dinner },
      gcal_events_created: Object.keys(newMealIds).length,
      message: `Meal plan written for ${date}. GCal events ${isGcalEnabled() ? 'created/updated' : 'skipped (GCal not configured)'}.`,
    });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

export const planMealToolDef = {
  name: 'plan_meal',
  description: 'Plan meals for a date — updates journal frontmatter and creates/updates GCal events on Family calendar (3 events: breakfast, lunch, dinner). Meal times configurable in health/STATE.md under "## Meal Times".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      date:      { type: 'string' as const, description: 'Date (YYYY-MM-DD)' },
      breakfast: { type: 'string' as const, description: 'Breakfast dish name' },
      lunch:     { type: 'string' as const, description: 'Lunch dish name' },
      dinner:    { type: 'string' as const, description: 'Dinner dish name' },
      notes:     { type: 'string' as const, description: 'Optional meal notes' },
    },
    required: ['date', 'breakfast', 'lunch', 'dinner'] as const,
  },
};
