// Import express-async-errors FIRST for automatic async error propagation
import 'express-async-errors';

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { setupOAuth } from 'mcp-oauth-password';
import { errorHandler } from './middleware/error.js';
import { authMiddleware } from './middleware/auth.js';
import { oauthConfig } from '../config.js';

const app = express();

// Trust Railway proxy (CRITICAL - must be FIRST)
app.set('trust proxy', 1);

// Body parsers (BEFORE session)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Setup OAuth session middleware and endpoints (BEFORE application routes)
const { pool: pgPool } = setupOAuth(app, oauthConfig);

// Configure EJS for OAuth login page
app.set('view engine', 'ejs');
app.set('views', './node_modules/mcp-oauth-password/views');

// Health check (Railway requirement for zero-downtime deploys)
app.get('/', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'mindstone-intelligence',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Centralized error handler (MUST be last middleware)
app.use(errorHandler);

export default app;
export { pgPool };
