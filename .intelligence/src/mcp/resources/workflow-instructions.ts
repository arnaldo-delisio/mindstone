/**
 * Workflow Instructions Resource
 *
 * Provides Claude with guidance on the available MCP tools and workflows.
 * Forked from vault — updated to document all 7 tools (4 note tools + 3 event tools).
 *
 * Note: This resource is available but not registered in mcp-server.ts in Phase 2.
 * Future phases may register it as needed.
 */

export const workflowInstructionsResource = {
  uri: 'vault://workflow/content-capture',
  name: 'Content Capture Workflow',
  mimeType: 'text/plain',
  description: 'Instructions for the two-stage content capture workflow using extract_content and available MCP tools'
};

export function getWorkflowInstructions(): string {
  return `# MindStone MCP Tools

## Available Tools

### extract_content
Extract content from URL (YouTube, web article, PDF, GitHub).
Saves extracted content to the library/ directory in Supabase, triggers background
intelligence processing (tagging, summary, embeddings).

### search_notes
Hybrid BM25 + semantic search across vault files.
Combines keyword matching with vector similarity for accurate, context-aware results.

### read_note
Read full content of any vault file by path.
Returns the raw markdown content including frontmatter.

### manage_note
Create, update, or delete any vault file; triggers intelligence pipeline.
Creating or updating a file queues it for auto-tagging, summarization, and embeddings.

### manage_event
Create, update, complete, or cancel vault events with GCal sync.
Actions: create (creates event file + GCal entry), update (edits fields + GCal), complete (marks done), cancel (hard-deletes vault file + GCal event — GCal must be reachable).
Required fields for create: title, start_time (ISO 8601), calendar (must match a name in calendars.json).

### list_events
Query vault events by date, priority, context, or tag.
Supports filtering by status (upcoming/done/cancelled), date range, priority (high/medium/low), context, tags, and blocked_by.

### get_calendar_events
Fetch timed events from the vault for a given date or date range.
Parameters: date (YYYY-MM-DD, defaults to today), days (1=today only, 7=week view), calendars (subset to query), include_backlog (untimed events).

## Content Capture Workflow

When a user shares a URL (especially YouTube videos), follow this two-stage workflow:

### Stage 1: Extract Content
1. Call extract_content(url) with the user's URL
2. Review the returned preview and metadata
3. If extraction successful, the content is saved to library/ for future reference
4. If already cached (deduplication), you'll receive the existing content

### Stage 2: Synthesize and Save Learning
After reviewing the extracted content with the user:
1. Ask 2-3 sharpening questions before writing the synthesis:
   - "What's the core claim in one sentence?"
   - "Is there a specific trigger or situation where this applies?"
   - "Any related learnings to link?"
2. Use manage_note to save the synthesis to learnings/

## Key Points
- extract_content handles deduplication - same URL returns cached content
- Library files use author-title naming (e.g., "healthygamergg-stop-watching-youtube.md")
- extract_content returns the exact path after extraction - use that for source field
- tags can be left empty [] — AI auto-generates and merges them
- Both files (library content + learning) sync to laptop automatically
- Use search_notes to find related content across library and learnings

## Example Flow
User: "Check out this video: https://youtube.com/watch?v=abc123"
1. extract_content({ url: "https://youtube.com/watch?v=abc123" })
   → Returns path: "library/youtube/author-name-video-title.md"
2. Ask sharpening questions
3. manage_note({ action: "create", path: "learnings/insight-title.md", content: "---\\ntitle: <complete claim>\\ntags: []\\nsource: [[library/youtube/author-name-video-title]]\\ncreated_at: '...'\\ntype: learning\\n---\\n\\n## The Insight\\n...\\n\\n## When to Apply\\n..." })
`;
}
