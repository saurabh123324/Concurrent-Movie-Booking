// Configuration loaded from environment variables with sensible defaults
// WHY: Centralized config makes it easy to adjust for different environments

export const config = {
    // Server
    port: parseInt(process.env.PORT || '3000', 10),

    // PostgreSQL
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USER || 'movies',
        password: process.env.DB_PASSWORD || 'movies123',
        database: process.env.DB_NAME || 'movie_reservation',
    },

    // Redis
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
    },

    // Business Rules
    seatHoldTTLSeconds: 120, // 2 minutes - matches Redis lock TTL
};
