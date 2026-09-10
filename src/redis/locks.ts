import { redis, isRedisAvailable } from './client.js';
import { config } from '../config.js';

// Distributed Lock Implementation
// WHY: Redis provides fast, atomic locking that works across multiple backend instances
// This is ADVISORY - the database is the final authority

const TTL_SECONDS = config.seatHoldTTLSeconds;

/**
 * Generate Redis key for a seat lock
 * Format: seat:{showId}:{seatId}
 */
function getLockKey(showId: string, seatId: string): string {
    return `seat:${showId}:${seatId}`;
}

/**
 * Attempt to acquire a lock on a seat
 * 
 * WHY SET NX EX:
 * - NX (Not eXists): Only set if key doesn't exist → atomic check-and-set
 * - EX (Expire): Auto-expire after TTL → prevents orphaned locks
 * 
 * @returns true if lock acquired, false if already held
 */
export async function acquireSeatLock(
    showId: string,
    seatId: string,
    userId: string
): Promise<{ success: boolean; error?: 'REDIS_UNAVAILABLE' | 'ALREADY_LOCKED' }> {
    if (!(await isRedisAvailable())) {
        return { success: false, error: 'REDIS_UNAVAILABLE' };
    }

    const key = getLockKey(showId, seatId);

    try {
        // Check if current user already owns the lock (refresh scenario)
        const currentOwner = await redis.get(key);
        if (currentOwner === userId) {
            // Refresh TTL for the same user
            await redis.expire(key, TTL_SECONDS);
            return { success: true };
        }

        // Attempt atomic lock acquisition
        // SET key userId NX EX 120
        const result = await redis.set(key, userId, 'EX', TTL_SECONDS, 'NX');

        if (result === 'OK') {
            return { success: true };
        } else {
            return { success: false, error: 'ALREADY_LOCKED' };
        }
    } catch (error) {
        console.error('Redis lock acquisition error:', error);
        return { success: false, error: 'REDIS_UNAVAILABLE' };
    }
}

/**
 * Release a seat lock (only if owned by the user)
 * 
 * WHY Lua Script:
 * - Atomic check-and-delete prevents releasing someone else's lock
 * - If the lock expired and was acquired by another user, we don't accidentally release it
 */
export async function releaseSeatLock(
    showId: string,
    seatId: string,
    userId: string
): Promise<boolean> {
    const key = getLockKey(showId, seatId);

    // Lua script: Only delete if value matches userId
    // WHY: This is atomic - no race between GET and DEL
    const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

    try {
        const result = await redis.eval(script, 1, key, userId);
        return result === 1;
    } catch (error) {
        console.error('Redis lock release error:', error);
        return false;
    }
}

/**
 * Check if a lock is owned by a specific user
 */
export async function isLockOwnedBy(
    showId: string,
    seatId: string,
    userId: string
): Promise<boolean> {
    const key = getLockKey(showId, seatId);

    try {
        const owner = await redis.get(key);
        return owner === userId;
    } catch (error) {
        console.error('Redis lock check error:', error);
        return false;
    }
}

/**
 * Get remaining TTL for a lock
 * @returns TTL in seconds, -2 if key doesn't exist, -1 if no TTL
 */
export async function getLockTTL(showId: string, seatId: string): Promise<number> {
    const key = getLockKey(showId, seatId);

    try {
        return await redis.ttl(key);
    } catch (error) {
        console.error('Redis TTL check error:', error);
        return -2;
    }
}

/**
 * Get lock owner for a seat
 */
export async function getLockOwner(showId: string, seatId: string): Promise<string | null> {
    const key = getLockKey(showId, seatId);

    try {
        return await redis.get(key);
    } catch (error) {
        console.error('Redis get owner error:', error);
        return null;
    }
}
