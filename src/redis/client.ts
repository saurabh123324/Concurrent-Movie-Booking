import Redis from 'ioredis';
import { config } from '../config.js';

// WHY: Single Redis instance for the entire application
// Redis is single-threaded, so all operations are naturally serialized
export const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
        // Exponential backoff with max 2 seconds
        const delay = Math.min(times * 100, 2000);
        return delay;
    },
});

redis.on('error', (err) => {
    console.error('Redis connection error:', err);
    // Don't crash - let requests fail gracefully with REDIS_UNAVAILABLE
});

redis.on('connect', () => {
    console.log('Connected to Redis');
});

// Check if Redis is available
export async function isRedisAvailable(): Promise<boolean> {
    try {
        await redis.ping();
        return true;
    } catch {
        return false;
    }
}
