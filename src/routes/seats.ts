import { Router, Request, Response } from 'express';
import { holdSeat, releaseSeat } from '../services/seatService.js';
import { confirmBooking } from '../services/bookingService.js';
import type { HoldSeatRequest, ConfirmBookingRequest } from '../types/index.js';

const router = Router();

/**
 * POST /seats/hold
 * Attempt to hold a seat for booking
 * 
 * REQUEST BODY:
 * {
 *   showId: string,
 *   seatId: string,
 *   userId: string (client-generated session ID)
 * }
 * 
 * RESPONSE (success):
 * {
 *   success: true,
 *   seat: { id, row, number, status: "HELD" },
 *   expiresAt: ISO timestamp
 * }
 * 
 * RESPONSE (failure):
 * {
 *   success: false,
 *   error: "SEAT_ALREADY_HELD" | "SEAT_ALREADY_BOOKED" | "SEAT_NOT_FOUND" | "REDIS_UNAVAILABLE"
 * }
 * 
 * IDEMPOTENCY:
 * - If same userId re-holds same seat, TTL is refreshed
 * - This allows users to extend their hold by clicking again
 */
router.post('/hold', async (req: Request, res: Response) => {
    try {
        const { showId, seatId, userId } = req.body as HoldSeatRequest;

        // Basic validation
        if (!showId || !seatId || !userId) {
            res.status(400).json({
                success: false,
                error: 'Missing required fields: showId, seatId, userId'
            });
            return;
        }

        const result = await holdSeat(showId, seatId, userId);

        if (result.success) {
            res.json(result);
        } else {
            // Return appropriate HTTP status based on error
            const status = result.error === 'SEAT_NOT_FOUND' ? 404
                : result.error === 'REDIS_UNAVAILABLE' ? 503
                    : 409; // Conflict for ALREADY_HELD or ALREADY_BOOKED
            res.status(status).json(result);
        }
    } catch (error) {
        console.error('Error holding seat:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * POST /seats/release
 * Release a held seat
 * 
 * WHY: User can manually release before TTL expires (changed mind)
 */
router.post('/release', async (req: Request, res: Response) => {
    try {
        const { showId, seatId, userId } = req.body;

        if (!showId || !seatId || !userId) {
            res.status(400).json({
                success: false,
                error: 'Missing required fields: showId, seatId, userId'
            });
            return;
        }

        const released = await releaseSeat(showId, seatId, userId);
        res.json({ success: released });
    } catch (error) {
        console.error('Error releasing seat:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * POST /seats/confirm
 * Confirm a booking (convert HELD → BOOKED)
 * 
 * REQUEST BODY:
 * {
 *   showId: string,
 *   seatId: string,
 *   userId: string,
 *   requestId: string (client-generated UUID for idempotency)
 * }
 * 
 * RESPONSE (success):
 * {
 *   success: true,
 *   booking: { id, seatId, confirmedAt }
 * }
 * 
 * RESPONSE (failure):
 * {
 *   success: false,
 *   error: "LOCK_NOT_OWNED" | "SEAT_ALREADY_BOOKED" | "REQUEST_ALREADY_PROCESSED" | "SEAT_NOT_FOUND"
 * }
 * 
 * IDEMPOTENCY:
 * - Client must provide unique requestId
 * - Retrying with same requestId returns same result
 * - This is critical for handling network failures and retries
 */
router.post('/confirm', async (req: Request, res: Response) => {
    try {
        const { showId, seatId, userId, requestId } = req.body as ConfirmBookingRequest;

        // Basic validation
        if (!showId || !seatId || !userId || !requestId) {
            res.status(400).json({
                success: false,
                error: 'Missing required fields: showId, seatId, userId, requestId'
            });
            return;
        }

        const result = await confirmBooking(showId, seatId, userId, requestId);

        if (result.success) {
            res.json(result);
        } else {
            // Return appropriate HTTP status based on error
            const status = result.error === 'SEAT_NOT_FOUND' ? 404
                : 409; // Conflict for all other errors
            res.status(status).json(result);
        }
    } catch (error) {
        console.error('Error confirming booking:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
