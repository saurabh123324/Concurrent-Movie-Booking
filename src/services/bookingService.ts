import { pool, withTransaction } from '../db/connection.js';
import { isLockOwnedBy, releaseSeatLock } from '../redis/locks.js';
import type { ConfirmBookingResponse, Booking } from '../types/index.js';

/**
 * Booking Service - Handles booking confirmation
 * 
 * CRITICAL PATH:
 * This is where Redis advisory locks meet PostgreSQL authority.
 * The database has the final word on whether a booking succeeds.
 */

/**
 * Confirm a booking (convert HELD → BOOKED)
 * 
 * IDEMPOTENCY:
 * - Client provides a unique requestId
 * - If we've seen this requestId before, return the previous result
 * - This prevents accidental double-bookings from retries
 * 
 * TRANSACTION FLOW:
 * 1. Check for existing booking_request (idempotency)
 * 2. Verify Redis lock ownership (advisory check)
 * 3. Within a transaction:
 *    a. Create pending booking_request
 *    b. Verify seat is still HELD by this user
 *    c. Create booking record
 *    d. Update seat to BOOKED
 *    e. Mark booking_request as COMPLETED
 * 4. Release Redis lock (cleanup)
 * 
 * WHY TRANSACTION:
 * - All-or-nothing: Either the booking succeeds completely or fails completely
 * - PostgreSQL UNIQUE constraint on bookings.seat_id is the final guard
 */
export async function confirmBooking(
    showId: string,
    seatId: string,
    userId: string,
    requestId: string
): Promise<ConfirmBookingResponse> {

    // Step 1: Check idempotency - have we processed this request before?
    const existingRequest = await pool.query<{ status: string; booking_id: string | null }>(
        `SELECT status, booking_id FROM booking_requests WHERE request_id = $1`,
        [requestId]
    );

    if (existingRequest.rows.length > 0) {
        const req = existingRequest.rows[0];

        if (req.status === 'COMPLETED' && req.booking_id) {
            // Already processed successfully - return the same result
            const bookingResult = await pool.query<Booking>(
                `SELECT id, seat_id as "seatId", confirmed_at as "confirmedAt" 
         FROM bookings WHERE id = $1`,
                [req.booking_id]
            );

            const booking = bookingResult.rows[0];
            return {
                success: true,
                booking: {
                    id: booking.id,
                    seatId: booking.seatId,
                    confirmedAt: booking.confirmedAt.toISOString(),
                },
            };
        }

        if (req.status === 'FAILED') {
            return { success: false, error: 'REQUEST_ALREADY_PROCESSED' };
        }

        // PENDING - unusual, might be from a crashed request
        // Fall through to try again
    }

    // Step 2: Verify Redis lock ownership (advisory check)
    // WHY: Fast fail if someone else holds the lock
    // This is advisory - the DB transaction is the real check
    const ownsLock = await isLockOwnedBy(showId, seatId, userId);
    if (!ownsLock) {
        // Record the failed attempt for idempotency
        await pool.query(
            `INSERT INTO booking_requests (request_id, seat_id, status) 
       VALUES ($1, $2, 'FAILED')
       ON CONFLICT (request_id) DO NOTHING`,
            [requestId, seatId]
        );
        return { success: false, error: 'LOCK_NOT_OWNED' };
    }

    // Step 3: Execute booking transaction
    try {
        const booking = await withTransaction(async (client) => {
            // 3a. Create pending booking_request (or update if exists from previous crash)
            await client.query(
                `INSERT INTO booking_requests (request_id, seat_id, status) 
         VALUES ($1, $2, 'PENDING')
         ON CONFLICT (request_id) DO UPDATE SET status = 'PENDING'`,
                [requestId, seatId]
            );

            // 3b. Verify seat state in database
            // WHY: Redis lock could have expired between our check and now
            // Use FOR UPDATE to lock the row during transaction
            const seatResult = await client.query<{ status: string; held_by: string }>(
                `SELECT status, held_by FROM seats 
         WHERE id = $1 AND show_id = $2 
         FOR UPDATE`,
                [seatId, showId]
            );

            if (seatResult.rows.length === 0) {
                throw new Error('SEAT_NOT_FOUND');
            }

            const seat = seatResult.rows[0];

            if (seat.status === 'BOOKED') {
                throw new Error('SEAT_ALREADY_BOOKED');
            }

            // Verify this user held the seat
            // WHY: Defense in depth - even if Redis says yes, DB must agree
            if (seat.held_by !== userId) {
                throw new Error('LOCK_NOT_OWNED');
            }

            // 3c. Create booking record
            // WHY: UNIQUE constraint on seat_id is the final guard against double-booking
            const bookingResult = await client.query<Booking>(
                `INSERT INTO bookings (seat_id, user_id) 
         VALUES ($1, $2)
         RETURNING id, seat_id as "seatId", confirmed_at as "confirmedAt"`,
                [seatId, userId]
            );

            const newBooking = bookingResult.rows[0];

            // 3d. Update seat to BOOKED
            await client.query(
                `UPDATE seats 
         SET status = 'BOOKED', held_by = NULL, held_until = NULL 
         WHERE id = $1`,
                [seatId]
            );

            // 3e. Mark booking_request as COMPLETED
            await client.query(
                `UPDATE booking_requests 
         SET status = 'COMPLETED', booking_id = $1 
         WHERE request_id = $2`,
                [newBooking.id, requestId]
            );

            return newBooking;
        });

        // Step 4: Release Redis lock (cleanup)
        // WHY: The seat is now BOOKED, no need for the lock
        // Even if this fails, it will expire naturally
        await releaseSeatLock(showId, seatId, userId);

        return {
            success: true,
            booking: {
                id: booking.id,
                seatId: booking.seatId,
                confirmedAt: booking.confirmedAt.toISOString(),
            },
        };

    } catch (error) {
        // Mark request as failed for idempotency
        await pool.query(
            `UPDATE booking_requests SET status = 'FAILED' WHERE request_id = $1`,
            [requestId]
        );

        const message = error instanceof Error ? error.message : 'Unknown error';

        if (message === 'SEAT_NOT_FOUND') {
            return { success: false, error: 'SEAT_NOT_FOUND' };
        }
        if (message === 'SEAT_ALREADY_BOOKED') {
            return { success: false, error: 'SEAT_ALREADY_BOOKED' };
        }
        if (message === 'LOCK_NOT_OWNED') {
            return { success: false, error: 'LOCK_NOT_OWNED' };
        }

        // Check for unique constraint violation (double-booking attempt)
        if (message.includes('unique constraint') || message.includes('duplicate key')) {
            return { success: false, error: 'SEAT_ALREADY_BOOKED' };
        }

        // Unexpected error - rethrow
        throw error;
    }
}

/**
 * Get booking by ID
 */
export async function getBooking(bookingId: string): Promise<Booking | null> {
    const result = await pool.query<Booking>(
        `SELECT id, seat_id as "seatId", user_id as "userId", confirmed_at as "confirmedAt"
     FROM bookings WHERE id = $1`,
        [bookingId]
    );

    return result.rows[0] || null;
}
