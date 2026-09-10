import { pool } from './connection.js';

// Database schema setup
// WHY: Explicit SQL makes the constraints visible and auditable
// Run once: npm run migrate

async function migrate() {
    console.log('Starting database migration...');

    const client = await pool.connect();
    try {
        // Drop tables if they exist (for demo reset)
        await client.query(`
      DROP TABLE IF EXISTS booking_requests CASCADE;
      DROP TABLE IF EXISTS bookings CASCADE;
      DROP TABLE IF EXISTS seats CASCADE;
      DROP TABLE IF EXISTS shows CASCADE;
    `);

        // shows: Movie showtimes (one hardcoded for demo)
        await client.query(`
      CREATE TABLE shows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        movie_name VARCHAR(255) NOT NULL,
        theatre_name VARCHAR(255) NOT NULL,
        showtime TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
        console.log('✓ Created shows table');

        // seats: Physical seats with status
        // WHY: UNIQUE constraint on (show_id, row_label, seat_number) is the FINAL authority
        // This prevents double-booking at the database level, even if Redis fails
        await client.query(`
      CREATE TABLE seats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        show_id UUID REFERENCES shows(id) ON DELETE CASCADE,
        row_label CHAR(1) NOT NULL,
        seat_number INT NOT NULL,
        status VARCHAR(20) DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED')),
        held_by UUID,
        held_until TIMESTAMPTZ,
        UNIQUE(show_id, row_label, seat_number)
      );
      CREATE INDEX idx_seats_show_id ON seats(show_id);
      CREATE INDEX idx_seats_status ON seats(status);
    `);
        console.log('✓ Created seats table');

        // bookings: Confirmed reservations (immutable once created)
        // WHY: UNIQUE on seat_id ensures one booking per seat - database-level guarantee
        await client.query(`
      CREATE TABLE bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seat_id UUID REFERENCES seats(id) ON DELETE CASCADE UNIQUE,
        user_id UUID NOT NULL,
        confirmed_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX idx_bookings_user_id ON bookings(user_id);
    `);
        console.log('✓ Created bookings table');

        // booking_requests: Idempotency tracking
        // WHY: Prevents duplicate booking confirmations from creating multiple bookings
        // Client sends same request_id twice → second request returns original result
        await client.query(`
      CREATE TABLE booking_requests (
        request_id UUID PRIMARY KEY,
        seat_id UUID REFERENCES seats(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
        booking_id UUID REFERENCES bookings(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
        console.log('✓ Created booking_requests table');

        console.log('Migration completed successfully!');
    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch(console.error);
