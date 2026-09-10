import { Router, Request, Response } from 'express';
import { pool } from '../db/connection.js';
import { getSeatsForShow } from '../services/seatService.js';

const router = Router();

/**
 * GET /shows
 * List all shows (for demo, we only have one)
 */
router.get('/', async (_req: Request, res: Response) => {
    try {
        const result = await pool.query(
            `SELECT id, movie_name as "movieName", theatre_name as "theatreName", 
              showtime, created_at as "createdAt"
       FROM shows
       ORDER BY showtime`
        );

        res.json({ shows: result.rows });
    } catch (error) {
        console.error('Error fetching shows:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * GET /shows/:showId
 * Get a single show
 */
router.get('/:showId', async (req: Request, res: Response) => {
    try {
        const { showId } = req.params;

        const result = await pool.query(
            `SELECT id, movie_name as "movieName", theatre_name as "theatreName", 
              showtime, created_at as "createdAt"
       FROM shows
       WHERE id = $1`,
            [showId]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Show not found' });
            return;
        }

        res.json({ show: result.rows[0] });
    } catch (error) {
        console.error('Error fetching show:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * GET /shows/:showId/seats
 * Get all seats for a show with their current status
 * 
 * RESPONSE:
 * - seats: Array of seat objects with id, row, number, status, ttlSeconds (if HELD)
 * - heldBy is only included if the requesting user holds the seat
 * 
 * WHY POLLING:
 * - Frontend polls this endpoint every 2 seconds
 * - Simpler than WebSockets for a demo
 * - Acceptable latency for seat status updates
 */
router.get('/:showId/seats', async (req: Request, res: Response) => {
    try {
        const { showId } = req.params;
        // userId is optional - used to reveal "your" held seats
        const userId = req.query.userId as string | undefined;

        // Verify show exists
        const showResult = await pool.query('SELECT id FROM shows WHERE id = $1', [showId]);
        if (showResult.rows.length === 0) {
            res.status(404).json({ error: 'Show not found' });
            return;
        }

        const seats = await getSeatsForShow(showId, userId);
        res.json({ seats });
    } catch (error) {
        console.error('Error fetching seats:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

export default router;
