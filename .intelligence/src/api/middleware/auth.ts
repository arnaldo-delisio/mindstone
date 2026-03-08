import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Hybrid authentication middleware
 * Accepts EITHER:
 * 1. API Key (X-API-Key header) - for internal API calls
 * 2. OAuth Session (req.session.authenticated) - for PWA users
 *
 * Applied to /api routes only (NOT /mcp, NOT /)
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Check for session-based OAuth authentication (PWA users)
  if (req.session && (req.session as any).authenticated) {
    // OAuth session is valid, allow access
    next();
    return;
  }

  // Check for API key authentication (internal API calls)
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || typeof apiKey !== 'string') {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required (X-API-Key header or OAuth session)'
    });
    return;
  }

  const expected = process.env.API_KEY;
  if (!expected) {
    res.status(500).json({
      error: 'Server configuration error',
      message: 'API_KEY not configured'
    });
    return;
  }

  // Timing-safe comparison to prevent timing attacks
  const a = Buffer.from(apiKey);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
    return;
  }

  // API key authentication successful, continue to route
  next();
}
