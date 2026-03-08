/**
 * manage_note MCP Tool
 *
 * CRUD operations on any vault file (notes, learnings, library items)
 * by natural language reference. For events, use manage_event instead.
 *
 * Delete is a hard DELETE from Supabase. Daemon syncs the DELETE event
 * back to local filesystem automatically (bidirectional delete sync).
 */

import { supabase } from '../../services/supabase.js';
import { USER_ID } from '../../config.js';
import { searchNotes } from './search.js';
import { createHash } from 'crypto';

/* -------------------------------------------------------------------------- */
/* Interface                                                                   */
/* -------------------------------------------------------------------------- */

export interface ManageNoteArgs {
  /** UUID from a previous create/get response. When provided, skips all path/semantic matching and does a direct DB lookup. */
  id?: string;
  /** Natural language file reference (e.g. "my TypeScript learning", "the React article").
   *  For `create` action, must be an exact vault path (e.g. "subjects/music/sessions/2026-02-22.md"). */
  file_ref: string;
  action: 'get' | 'update' | 'delete' | 'create';
  /**
   * For update action: fields to merge into frontmatter.
   * Special key 'body' replaces the file body.
   */
  updates?: {
    title?: string;
    tags?: string[];
    body?: string;
    [key: string]: unknown;
  };
}

/* -------------------------------------------------------------------------- */
/* Excluded prefixes                                                           */
/* -------------------------------------------------------------------------- */

// Events have manage_event. System files are off-limits from this tool.
const EXCLUDED_PREFIXES = ['events/', 'system/'];

function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some(prefix => path.startsWith(prefix));
}

/* -------------------------------------------------------------------------- */
/* File resolution via semantic search                                         */
/* -------------------------------------------------------------------------- */

interface FileRow {
  id: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string | null;
}

async function resolveNote(
  fileRef: string,
  id?: string
): Promise<{ match: FileRow } | { ambiguous: true; matches: string[] } | { notFound: true }> {
  // Fast-path: if id provided, skip all matching and do a direct DB lookup
  if (id) {
    const { data } = await supabase
      .from('files')
      .select('id, path, frontmatter, body')
      .eq('id', id)
      .eq('user_id', USER_ID)
      .single();
    if (data) return { match: data as FileRow };
    return { notFound: true };
  }

  // If fileRef looks like a vault path, try direct lookup first.
  const looksLikePath = fileRef.includes('/') || fileRef.endsWith('.md');
  if (looksLikePath) {
    if (isExcluded(fileRef)) return { notFound: true };
    const { data } = await supabase
      .from('files')
      .select('id, path, frontmatter, body')
      .eq('path', fileRef)
      .eq('user_id', USER_ID)
      .single();
    if (data) return { match: data as FileRow };
  }

  // Semantic search ranks best match first — trust results[0].
  // Only return ambiguous if top two scores are exactly tied (true ambiguity).
  // RRF scores are all tiny floats (~0.016); relative-gap thresholds never work.
  const response = await searchNotes(fileRef, 5);
  const results = response.results.filter(r => !isExcluded(r.path));

  if (results.length === 0) {
    return { notFound: true };
  }

  // Only treat as ambiguous when scores are exactly equal (true tie)
  if (results.length > 1) {
    const topScore = results[0].score ?? 0;
    const secondScore = results[1].score ?? 0;
    if (topScore === secondScore) {
      return {
        ambiguous: true,
        matches: results.slice(0, 5).map(r => r.path),
      };
    }
  }

  // Fetch full row from DB by path
  const matchedPath = results[0].path;
  const { data, error } = await supabase
    .from('files')
    .select('id, path, frontmatter, body')
    .eq('path', matchedPath)
    .eq('user_id', USER_ID)
    .single();

  if (error || !data) {
    return { notFound: true };
  }

  return { match: data as FileRow };
}

/* -------------------------------------------------------------------------- */
/* Tool implementation                                                         */
/* -------------------------------------------------------------------------- */

export async function manageNoteTool(args: ManageNoteArgs): Promise<string> {
  const { id, file_ref, action, updates } = args;

  try {
    /* ---------------------------------------------------------------------- */
    /* action: create                                                           */
    /* ---------------------------------------------------------------------- */

    if (action === 'create') {
      // create requires an explicit path — file doesn't exist yet so search is useless
      if (!file_ref.includes('/') && !file_ref.endsWith('.md')) {
        return JSON.stringify({
          success: false,
          error: 'create action requires a vault path (e.g. "subjects/music/sessions/2026-02-22.md")',
        });
      }

      if (isExcluded(file_ref)) {
        return JSON.stringify({
          success: false,
          error: `Cannot create files in excluded paths: ${EXCLUDED_PREFIXES.join(', ')}`,
        });
      }

      // Verify file doesn't already exist
      const { data: existing } = await supabase
        .from('files')
        .select('id')
        .eq('path', file_ref)
        .eq('user_id', USER_ID)
        .maybeSingle();

      if (existing) {
        return JSON.stringify({
          success: false,
          error: `File already exists at ${file_ref}. Use action: "update" to modify it.`,
        });
      }

      const { body: _body, ...frontmatterUpdates } = updates || {};
      const body = (updates?.body as string) || '';
      const frontmatter: Record<string, unknown> = { ...frontmatterUpdates };

      const grayMatter = await import('gray-matter');
      const fullContent = grayMatter.default.stringify(body, frontmatter);
      const content_hash = createHash('sha256').update(fullContent).digest('hex');

      const { data: insertedFile, error: insertError } = await supabase
        .from('files')
        .insert({
          path: file_ref,
          body,
          frontmatter,
          content_hash,
          updated_at: new Date().toISOString(),
          user_id: USER_ID,
          intelligence_status: 'pending',
          chunks_status: 'pending',
        })
        .select('id')
        .single();

      if (insertError) {
        throw new Error(`DB insert failed: ${insertError.message}`);
      }

      return JSON.stringify({
        success: true,
        id: insertedFile?.id,
        path: file_ref,
        message: `Created ${file_ref}`,
      });
    }

    const resolved = await resolveNote(file_ref, id);

    if ('notFound' in resolved) {
      return JSON.stringify({
        success: false,
        error: `No file found matching: "${file_ref}". Try a more specific description, or check if it's an event (use manage_event instead).`,
      });
    }

    if ('ambiguous' in resolved) {
      return JSON.stringify({
        success: false,
        ambiguous: true,
        matches: resolved.matches,
        message: `Multiple matches found for "${file_ref}". Which file did you mean? Paths: ${resolved.matches.join(', ')}`,
      });
    }

    const { match } = resolved;
    const { id: matchId, path, frontmatter, body } = match;

    /* ---------------------------------------------------------------------- */
    /* action: get                                                              */
    /* ---------------------------------------------------------------------- */

    if (action === 'get') {
      const bodyStr = body || '';
      return JSON.stringify({
        success: true,
        id: matchId,
        path,
        frontmatter,
        body_preview: bodyStr.slice(0, 500),
        full_body: bodyStr,
      });
    }

    /* ---------------------------------------------------------------------- */
    /* action: update                                                           */
    /* ---------------------------------------------------------------------- */

    if (action === 'update') {
      if (!updates || Object.keys(updates).length === 0) {
        return JSON.stringify({
          success: false,
          error: 'No updates provided. Pass fields to merge into frontmatter, and/or body to replace content.',
        });
      }

      // Separate body from frontmatter updates
      const { body: newBody, ...frontmatterUpdates } = updates;

      // Shallow merge into existing frontmatter; null values remove the key
      const merged: Record<string, unknown> = { ...frontmatter, ...frontmatterUpdates };
      for (const key of Object.keys(frontmatterUpdates)) {
        if (frontmatterUpdates[key] === null) delete merged[key];
      }
      const updatedFrontmatter: Record<string, unknown> = {
        ...merged,
        updated_at: new Date().toISOString(),
      };

      // Body: replace if provided, otherwise keep existing
      const updatedBody = newBody !== undefined ? newBody : (body || '');

      // Recompute content hash
      const matter = await import('gray-matter');
      const fullContent = matter.default.stringify(updatedBody, updatedFrontmatter);
      const content_hash = createHash('sha256').update(fullContent).digest('hex');

      const { error: updateError } = await supabase
        .from('files')
        .update({
          frontmatter: updatedFrontmatter,
          body: updatedBody,
          content_hash,
          updated_at: new Date().toISOString(),
        })
        .eq('path', path)
        .eq('user_id', USER_ID);

      if (updateError) {
        throw new Error(`DB update failed: ${updateError.message}`);
      }

      // Re-enqueue for chunking to update embeddings
      await supabase.rpc('enqueue_file_for_chunking', {
        p_file_id: matchId,
        p_clear_existing_chunks: true,
      });

      return JSON.stringify({
        success: true,
        id: matchId,
        path,
        message: `Updated ${path}`,
        updated_fields: Object.keys(updates),
      });
    }

    /* ---------------------------------------------------------------------- */
    /* action: delete                                                          */
    /* ---------------------------------------------------------------------- */

    if (action === 'delete') {
      // Clean up GCal event if this file has one
      const fm = frontmatter as Record<string, unknown>;
      if (fm.gcal_event_id) {
        try {
          const { deleteGcalEvent } = await import('../../services/gcal.js');
          await deleteGcalEvent(fm.gcal_event_id as string, fm.gcal_calendar as string | undefined);
        } catch (err: any) {
          const loggerMod = await import('../../utils/logger.js');
          loggerMod.logger.warn({ err, path }, 'Failed to delete GCal event on note delete (non-critical)');
        }
      }

      // Hard delete reminder events that point to this file (via source_file_id)
      if (matchId) {
        const { data: reminderEvents } = await supabase
          .from('files')
          .select('id, path, frontmatter')
          .like('path', 'events/%')
          .eq('user_id', USER_ID)
          .eq('frontmatter->>source_file_id', matchId);

        for (const reminderEvent of reminderEvents ?? []) {
          const rFm = reminderEvent.frontmatter as Record<string, unknown>;
          if (rFm.gcal_event_id) {
            try {
              const { deleteGcalEvent } = await import('../../services/gcal.js');
              await deleteGcalEvent(rFm.gcal_event_id as string, rFm.gcal_calendar as string | undefined);
            } catch { /* ignore */ }
          }
          await supabase.from('files').delete().eq('id', reminderEvent.id).eq('user_id', USER_ID);
        }
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

      return JSON.stringify({
        success: true,
        id: matchId,
        path,
        message: `Deleted ${path}`,
      });
    }

    return JSON.stringify({
      success: false,
      error: `Unknown action: ${action}. Valid actions are: get, update, delete.`,
    });
  } catch (error: any) {
    return JSON.stringify({
      success: false,
      error: `manage_note failed: ${error.message}`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* MCP tool definition                                                         */
/* -------------------------------------------------------------------------- */

export const manageNoteToolDef = {
  name: 'manage_note',
  description:
    'Create, read, update, or delete any vault file by path or natural language reference. For events use manage_event instead. Delete is permanent — removes from Supabase and local filesystem.\n\nTo log to daily/YYYY-MM-DD.md or journal/YYYY-MM-DD.md: get the file first to understand the format, then append your entry and update with the full body. If the file doesn\'t exist, read an existing one from the same directory as a format reference before creating.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string' as const,
        description:
          'UUID from a previous create/get response. When provided, skips all path/semantic matching and does a direct DB lookup.',
      },
      file_ref: {
        type: 'string' as const,
        description:
          'For create: exact vault path (e.g. "subjects/music/sessions/2026-02-22.md"). For get/update/delete: natural language description or path (e.g. "my TypeScript learning", "subjects/music/STATE.md")',
      },
      action: {
        type: 'string' as const,
        enum: ['create', 'get', 'update', 'delete'] as const,
        description:
          'create: insert new file at path | get: return full file content | update: merge updates into frontmatter/body | delete: permanently delete file',
      },
      updates: {
        type: 'object' as const,
        description:
          'For update action: fields to merge into frontmatter (title, tags, etc.). Include "body" key to replace file body. Example: { "title": "New Title", "tags": ["react", "typescript"], "body": "New content..." }',
        properties: {
          title: { type: 'string' as const, description: 'New title' },
          tags: {
            type: 'array' as const,
            items: { type: 'string' as const },
            description: 'New tags (replaces existing tags)',
          },
          body: { type: 'string' as const, description: 'New body content (replaces existing body)' },
        },
        additionalProperties: true,
      },
    },
    required: ['file_ref', 'action'] as const,
  },
};
