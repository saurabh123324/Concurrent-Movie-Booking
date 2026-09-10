import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import showsRouter from './routes/shows.js';
import seatsRouter from './routes/seats.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { cleanupExpiredHolds } from './services/seatService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// API Routes
app.use('/shows', showsRouter);
app.use('/seats', seatsRouter);

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Periodic cleanup of expired holds
// WHY: Redis TTL handles lock expiry, but PostgreSQL status needs syncing
// This catches any seats where Redis expired but DB status wasn't updated
// (e.g., if the server crashed during a hold operation)
const CLEANUP_INTERVAL_MS = 30000; // 30 seconds

setInterval(async () => {
    try {
        const cleaned = await cleanupExpiredHolds();
        if (cleaned > 0) {
            console.log(`Cleaned up ${cleaned} expired seat holds`);
        }
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
}, CLEANUP_INTERVAL_MS);

// Start server
app.listen(config.port, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           Movie Reservation System - Running               ║
╠════════════════════════════════════════════════════════════╣
║  Server:    http://localhost:${config.port}                        ║
║  Database:  PostgreSQL @ ${config.database.host}:${config.database.port}              ║
║  Redis:     Redis @ ${config.redis.host}:${config.redis.port}                    ║
╠════════════════════════════════════════════════════════════╣
║  API Endpoints:                                            ║
║    GET  /shows                - List all shows             ║
║    GET  /shows/:showId        - Get show details           ║
║    GET  /shows/:showId/seats  - Get seats for a show       ║
║    POST /seats/hold           - Hold a seat                ║
║    POST /seats/release        - Release a held seat        ║
║    POST /seats/confirm        - Confirm booking            ║
╚════════════════════════════════════════════════════════════╝
  `);
});
