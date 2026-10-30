// ── Simple Error Handler (TypeScript Fix) ───────────────────────
import type { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const statusCode = err.statusCode || 500;
  
  console.error(`[${new Date().toISOString()}] Error:`, {
    message: err.message,
    statusCode,
    stack: err.stack
  });

  const response: any = {
    error: {
      message: statusCode === 500 ? 'Internal server error' : err.message,
      statusCode,
      timestamp: new Date().toISOString()
    }
  };

  if (process.env.NODE_ENV === 'development') {
    response.error.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({
    error: {
      message: 'Resource not found',
      statusCode: 404,
      timestamp: new Date().toISOString()
    }
  });
}