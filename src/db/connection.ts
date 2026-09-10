import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// WHY: Connection pooling is essential for handling concurrent requests
// Each request gets a connection from the pool, returns it when done
export const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    max: 20, // Maximum connections in pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Graceful shutdown
pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
    // Don't crash the server - let the request fail gracefully
});

// Helper for transactions
// WHY: Transactions ensure atomicity - either all operations succeed or none do
export async function withTransaction<T>(
    callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
