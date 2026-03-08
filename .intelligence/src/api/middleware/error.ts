import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger.js';
import { trackAnalytics } from '../../utils/analytics.js';

/**
 * Custom error classes for different status codes
 */
export class BadRequestError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends Error {
  statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends Error {
  statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class TimeoutError extends Error {
  statusCode = 504;
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Centralized error handler middleware
 * Logs errors, tracks analytics, returns appropriate status codes
 * MUST be the last middleware in Express app
 */
export function errorHandler(
  err: Error & { statusCode?: number },
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Determine status code
  const statusCode = err.statusCode || 500;
  const isServerError = statusCode >= 500;

  // Log error with context
  logger.error({
    error: {
      name: err.name,
      message: err.message,
      stack: isServerError ? err.stack : undefined
    },
    request: {
      method: req.method,
      path: req.path,
      query: req.query
    }
  }, 'Request failed');

  // Track to analytics (non-blocking)
  trackAnalytics({
    operation_type: 'api_request',
    status: 'failed',
    duration_ms: 0, // Could add request timing if needed
    error_type: err.name,
    error_message: err.message,
    request_path: req.path,
    request_method: req.method,
    request_source: req.path.startsWith('/api') ? 'pwa' : 'mcp'
  }).catch(() => {
    // Ignore analytics tracking errors
  });

  // Send error response
  res.status(statusCode).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && isServerError ? { stack: err.stack } : {})
  });
}
