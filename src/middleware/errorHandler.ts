import { Request, Response, NextFunction } from 'express';

/**
 * Centralized error handling middleware
 * 
 * WHY: 
 * - Consistent error response format
 * - Prevents leaking stack traces in production
 * - Single place to add logging, monitoring, etc.
 */
export function errorHandler(
    err: Error,
    _req: Request,
    res: Response,
    _next: NextFunction
): void {
    console.error('Unhandled error:', err);

    // Don't leak internal error details
    res.status(500).json({
        success: false,
        error: 'Internal server error',
    });
}

/**
 * 404 handler for undefined routes
 */
export function notFoundHandler(_req: Request, res: Response): void {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
    });
}
