import { pool } from '../db/connection.js';
import { acquireSeatLock, releaseSeatLock, getLockTTL, getLockOwner } from '../redis/locks.js';
import type { Seat, SeatResponse, HoldSeatResponse } from '../types/index.js';
import { config } from '../config.js';

/**
 * Seat Service - Core business logic for seat operations
 * 
 * RESPONSIBILITY SPLIT:
 * - Redis: Fast advisory locks for immediate UI feedback
 * - PostgreSQL: Source of truth for seat status
 * 
 * When they disagree, PostgreSQL wins.
 */

/**
 * Get all seats for a show with their current status
 * 
 * WHY: Combines Redis TTL info with PostgreSQL status
 * Redis provides accurate remaining hold time; PostgreSQL provides authoritative status
 */
export async function getSeatsForShow(showId: string, requestingUserId?: string): Promise<SeatResponse[]> {
    const result = await pool.query<Seat>(
        `SELECT id, show_id as "showId", row_label as "rowLabel", seat_number as "seatNumber", 
            status, held_by as "heldBy", held_until as "heldUntil"
     FROM seats 
     WHERE show_id = $1 
     ORDER BY row_label, seat_number`,
        [showId]
    );

    const seats: SeatResponse[] = [];

    for (const seat of result.rows) {
        let status = seat.status;
        let ttlSeconds: number | undefined;
        let heldBy: string | undefined;

        // If seat is HELD, check if it's still valid
        if (status === 'HELD') {
            const redisTTL = await getLockTTL(showId, seat.id);

            if (redisTTL <= 0) {
                // Redis lock expired - seat should be available
                // WHY: We don't update DB here to avoid race conditions
                // The periodic cleanup or next hold attempt will fix it
                status = 'AVAILABLE';
            } else {
                ttlSeconds = redisTTL;

                // Only reveal who holds it if it's the requesting user
                if (requestingUserId && seat.heldBy === requestingUserId) {
                    heldBy = seat.heldBy;
                }
            }
        }

        seats.push({
            id: seat.id,
            row: seat.rowLabel,
            number: seat.seatNumber,
            status,
            ...(heldBy && { heldBy }),
            ...(ttlSeconds && { ttlSeconds }),
        });
    }

    return seats;
}

/**
 * Attempt to hold a seat
 * 
 * FLOW:
 * 1. Check if seat is already BOOKED in PostgreSQL (authoritative)
 * 2. Attempt Redis lock (fast, advisory)
 * 3. If Redis lock succeeds, update PostgreSQL status to HELD
 * 
 * WHY THIS ORDER:
 * - Check DB first: Don't waste time on Redis if already booked
 * - Redis lock: Prevents concurrent holds atomically
 * - DB update: Makes the hold visible to other instances
 */
export async function holdSeat(
    showId: string,
    seatId: string,
    userId: string
): Promise<HoldSeatResponse> {
    // Step 1: Check current seat status in PostgreSQL
    const seatResult = await pool.query<Seat>(
        `SELECT id, status, held_by as "heldBy" 
     FROM seats 
     WHERE id = $1 AND show_id = $2`,
        [seatId, showId]
    );

    if (seatResult.rows.length === 0) {
        return { success: false, error: 'SEAT_NOT_FOUND' };
    }

    const seat = seatResult.rows[0];

    // Already booked → permanently unavailable
    if (seat.status === 'BOOKED') {
        return { success: false, error: 'SEAT_ALREADY_BOOKED' };
    }

    // Step 2: Attempt to acquire Redis lock
    const lockResult = await acquireSeatLock(showId, seatId, userId);

    if (!lockResult.success) {
        if (lockResult.error === 'REDIS_UNAVAILABLE') {
            return { success: false, error: 'REDIS_UNAVAILABLE' };
        }
        // Already locked by someone else
        return { success: false, error: 'SEAT_ALREADY_HELD' };
    }

    // Step 3: Update PostgreSQL to reflect the hold
    // WHY: This makes the hold visible to other API instances and survives Redis restarts
    const expiresAt = new Date(Date.now() + config.seatHoldTTLSeconds * 1000);

    await pool.query(
        `UPDATE seats 
     SET status = 'HELD', held_by = $1, held_until = $2 
     WHERE id = $3`,
        [userId, expiresAt, seatId]
    );

    // Fetch updated seat for response
    const updatedResult = await pool.query<Seat>(
        `SELECT row_label as "rowLabel", seat_number as "seatNumber" 
     FROM seats WHERE id = $1`,
        [seatId]
    );

    const updatedSeat = updatedResult.rows[0];

    return {
        success: true,
        seat: {
            id: seatId,
            row: updatedSeat.rowLabel,
            number: updatedSeat.seatNumber,
            status: 'HELD',
            heldBy: userId,
            ttlSeconds: config.seatHoldTTLSeconds,
        },
        expiresAt: expiresAt.toISOString(),
    };
}

/**
 * Release a held seat
 * 
 * WHY: User cancels, or cleanup on session end
 */
export async function releaseSeat(
    showId: string,
    seatId: string,
    userId: string
): Promise<boolean> {
    // Release Redis lock (only if we own it)
    const released = await releaseSeatLock(showId, seatId, userId);

    if (released) {
        // Update PostgreSQL
        await pool.query(
            `UPDATE seats 
       SET status = 'AVAILABLE', held_by = NULL, held_until = NULL 
       WHERE id = $1 AND held_by = $2`,
            [seatId, userId]
        );
    }

    return released;
}

/**
 * Clean up expired holds in PostgreSQL
 * 
 * WHY: Redis TTL handles lock expiry, but PostgreSQL status needs syncing
 * This runs periodically to catch seats where Redis expired but DB wasn't updated
 */
export async function cleanupExpiredHolds(): Promise<number> {
    const result = await pool.query(
        `UPDATE seats 
     SET status = 'AVAILABLE', held_by = NULL, held_until = NULL 
     WHERE status = 'HELD' AND held_until < NOW()
     RETURNING id`
    );

    return result.rowCount || 0;
}
