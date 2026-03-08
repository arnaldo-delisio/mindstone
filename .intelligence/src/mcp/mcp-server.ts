import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { extractContentTool, extractContentToolDef } from './tools/extract-content.js';
import { searchNotesTool, searchNotesToolDef } from './tools/search.js';
import { readNoteTool } from './tools/read.js';
import { manageNoteTool, manageNoteToolDef } from './tools/manage-note.js';

// read_note tool definition (inline — kept simple for Phase 2)
const readNoteToolDef = {
  name: 'read_note',
  description: 'Read vault file contents by path. Optional search parameter filters to relevant sections in large files (uses semantic + keyword search).',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (e.g., "learnings/2024-01-15-api-design.md")'
      },
      search: {
        type: 'string',
        description: 'Optional search query to filter to relevant sections. Useful for large files (>50k chars). Uses semantic search in chunks for better results.'
      },
      id: {
        type: 'string',
        description: 'UUID for direct lookup. When provided, skips path-based lookup.'
      }
    },
    required: ['path']
  }
};

// Factory function to create MCP server instances (one per session)
export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'mindstone-intelligence',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {},
      }
    }
  );

  // List available tools — exactly 4 active tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      extractContentToolDef,
      searchNotesToolDef,
      readNoteToolDef,
      manageNoteToolDef,
    ]
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'extract_content') {
      try {
        const result = await extractContentTool(args as { url?: string; file?: string; fileName?: string; extraction_mode?: 'fast' | 'queue' });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : '';
        return {
          content: [{ type: 'text', text: `extract_content failed: ${msg}\n\nStack: ${stack}` }],
          isError: true
        };
      }
    }

    if (name === 'search_notes') {
      try {
        const result = await searchNotesTool(args as {
          query?: string;
          limit?: number;
          file_type?: 'library' | 'learnings' | 'daily' | 'mocs';
          tags?: string[];
          author?: string;
          source?: 'youtube' | 'article' | 'pdf';
          after?: string;
          before?: string;
          date_range?: 'today' | 'yesterday' | 'this_week' | 'this_month';
          sort?: 'newest_first' | 'oldest_first' | 'relevance';
        });
        return {
          content: [{ type: 'text', text: result }]
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Search failed: ${errorMsg}\n\n--- Debug Info ---\n[Handler] Error caught in MCP server handler\n[Handler] Args: ${JSON.stringify(args)}\n[Handler] Stack: ${error instanceof Error ? error.stack : 'No stack trace'}`
            }
          ],
          isError: true
        };
      }
    }

    if (name === 'read_note') {
      try {
        const result = await readNoteTool(args as { path: string; search?: string; id?: string });
        return { content: [{ type: 'text', text: result }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `read_note failed: ${msg}` }], isError: true };
      }
    }

    if (name === 'manage_note') {
      try {
        const result = await manageNoteTool(args as any);
        return { content: [{ type: 'text', text: result }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `manage_note failed: ${msg}` }], isError: true };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}
