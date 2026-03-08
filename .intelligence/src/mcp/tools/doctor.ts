/**
 * doctor MCP Tool
 *
 * Bootstraps a health journaling session on Claude Mobile.
 * Loads .personas/doctor.md + health state + last 7 journal entries in one call,
 * returning everything Claude needs to conduct the session.
 *
 * If health/STATE.md doesn't exist, returns new_patient instructions so the
 * Doctor can run the First Session Intake flow (Phases A → B → C → D → E).
 */

import { supabase } from '../../services/supabase.js';
import { USER_ID } from '../../config.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

async function readFile(path: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('files')
    .select('body')
    .eq('path', path)
    .eq('user_id', USER_ID)
    .maybeSingle();

  if (error || !data) return null;
  return data.body;
}

async function healthStateExists(): Promise<boolean> {
  const { data } = await supabase
    .from('files')
    .select('path')
    .eq('path', 'health/STATE.md')
    .eq('user_id', USER_ID)
    .maybeSingle();
  return !!data;
}

/* -------------------------------------------------------------------------- */
/* Tool implementation                                                          */
/* -------------------------------------------------------------------------- */

export async function doctorTool(): Promise<string> {
  try {
    // Always load doctor persona
    const doctorPersona = await readFile('.personas/doctor.md');
    if (!doctorPersona) {
      return JSON.stringify({
        success: false,
        error: '.personas/doctor.md not found. Make sure the vault daemon is running and the file has synced.',
      });
    }

    const hasState = await healthStateExists();

    // No health state — return new patient intake instructions
    if (!hasState) {
      return JSON.stringify({
        success: true,
        mode: 'new_patient',
        doctor_persona: doctorPersona,
        instructions: 'health/STATE.md not found. This is the first session. Follow the First Session Intake flow defined in the doctor persona (Phases A → B → C → D → E). Run all discovery phases before generating any files. Minimum 15-20 questions across phases A, B, and D.',
      });
    }

    // Load health state + last 7 journal entries in parallel
    const [stateRaw, journalFiles] = await Promise.all([
      readFile('health/STATE.md'),
      supabase
        .from('files')
        .select('path, body')
        .eq('user_id', USER_ID)
        .like('path', 'journal/%')
        .order('path', { ascending: false })
        .limit(7),
    ]);

    const journals = (journalFiles.data || []).map((f: { path: string; body: string | null }) => ({
      path: f.path,
      body: f.body,
    }));

    return JSON.stringify({
      success: true,
      mode: 'session',
      doctor_persona: doctorPersona,
      health_state: stateRaw ?? '(health/STATE.md not found)',
      journal_entries: journals,
      instructions: 'Session context loaded. Follow the doctor persona instructions. Run the session opening ritual before anything else: give a 7-day pattern summary (or 1-line recap if re-entry).',
    });
  } catch (error: any) {
    return JSON.stringify({
      success: false,
      error: `doctor failed: ${error.message}`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* MCP tool definition                                                          */
/* -------------------------------------------------------------------------- */

export const doctorToolDef = {
  name: 'doctor',
  description: 'Start a health journaling session with the doctor/psychologist persona. Loads the Doctor persona, health state, and last 7 journal entries in one call. Use when user wants to journal, track health, log habits/sleep/meals, or get health insights.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [] as const,
  },
};
