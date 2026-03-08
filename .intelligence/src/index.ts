// CRITICAL: Must be BEFORE all imports (see MCP-PATTERNS.md #1)
process.env.YTDL_DEBUG_PATH = '/tmp';

import dotenv from 'dotenv';

// Load environment from .env.local (for development)
dotenv.config({ path: '.env.local' });

import express, { Request, Response } from 'express';
import { createAuthMiddleware } from 'mcp-oauth-password';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import YTDlpWrap from 'yt-dlp-wrap';
import { promises as fs } from 'fs';
import { createMcpServer } from './mcp/mcp-server.js';
import app, { pgPool } from './api/server.js';
import { logger } from './utils/logger.js';
import { oauthConfig, PORT, ALLOW_PROD_QUEUES, EXTRACTION_QUEUE, INTELLIGENCE_QUEUE, EMBEDDINGS_QUEUE } from './config.js';
import { pollExtractionQueue } from './queue/extraction.js';
import { pollIntelligenceQueue } from './queue/intelligence.js';
import { pollEmbeddingsQueue } from './queue/embeddings.js';
import { startReminderCron } from './services/reminder-scanner.js';
import { startGcalPoller } from './services/gcal-poller.js';
import { startEventExpiryCron } from './services/event-expiry.js';

// Serve PWA static files from /pwa directory
app.use(express.static('pwa'));

// Create auth middleware to protect MCP endpoint
const mcpAuthMiddleware = createAuthMiddleware(oauthConfig);

// Session storage for MCP connections (stateful clients like Claude Code)
const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

// MCP Protocol Endpoints
// POST /mcp - Handle MCP JSON-RPC requests
app.post('/mcp', mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const isInitialize = req.body?.method === 'initialize';

  // Existing stateful session
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ error, sessionId }, 'MCP request error');
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
    return;
  }

  // New stateful session on initialize
  if (isInitialize && !sessionId) {
    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sid) => {
        logger.info({ sessionId: sid }, 'MCP session initialized');
      },
    });
    const server = createMcpServer();
    await server.connect(transport);
    sessions.set(newSessionId, { server, transport });
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ error, sessionId: newSessionId }, 'MCP initialize error');
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
    return;
  }

  // Stateless fallback — handles Claude Mobile which deletes sessions after init
  // Each request gets a fresh server+transport, no session tracking
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session ID in response
    });
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error({ error }, 'MCP stateless request error');
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /mcp - SSE stream (stateful sessions only)
app.get('/mcp', mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found. POST /mcp with method=initialize first.' });
  }

  const session = sessions.get(sessionId)!;
  try {
    await session.transport.handleRequest(req, res);
  } catch (error) {
    logger.error({ error, sessionId }, 'MCP SSE error');
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /mcp - Terminate session
app.delete('/mcp', mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    await session.server.close();
    sessions.delete(sessionId);
    logger.info({ sessionId }, 'MCP session terminated');
  }

  res.status(200).send();
});

// Start server
async function main() {
  logger.info({
    allowProdQueues: ALLOW_PROD_QUEUES,
    extractionQueue: EXTRACTION_QUEUE,
    intelligenceQueue: INTELLIGENCE_QUEUE,
    embeddingsQueue: EMBEDDINGS_QUEUE,
    port: PORT
  }, 'mindstone-intelligence service starting');

  if (ALLOW_PROD_QUEUES) {
    logger.warn('PRODUCTION QUEUES ENABLED - Processing live data');
  } else {
    logger.info('Using test queues for safe development');
  }

  // Create .failures/ directory
  try {
    await fs.mkdir('.failures', { recursive: true });
    logger.info('.failures/ directory ready');
  } catch (error) {
    logger.error({ error }, 'Failed to create .failures/ directory');
  }

  // Start API server
  app.listen(PORT, '0.0.0.0', async () => {
    logger.info({ port: PORT }, 'API server listening');
    logger.info(`Health check: http://localhost:${PORT}/`);
    logger.info(`OAuth endpoints ready at ${process.env.SERVER_URL}`);

    // yt-dlp is installed via nixpacks.toml as system package
    // No runtime download needed - available as 'yt-dlp' in PATH
    logger.info('yt-dlp available via system package for Whisper fallback');

    // Start reminder cron (fire-and-forget, not a queue poller)
    startReminderCron();
    startGcalPoller();
    startEventExpiryCron();
  });

  // Start concurrent queue processors (extraction → intelligence → embeddings)
  logger.info('Starting concurrent queue pollers');

  await Promise.all([
    pollExtractionQueue(),
    pollIntelligenceQueue(),
    pollEmbeddingsQueue()
  ]);
}

// Run service
main().catch(error => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});

// Export for testing
export { app, pgPool as pool };
