import { pool } from './connection.js';

// Seed data: Multiple movies with various showtimes
// Morning (10:00), Afternoon (14:00), Evening (18:00), Night (21:00), Midnight (00:00)

const MOVIES = [
    { name: 'Inception', duration: 148, genre: 'Sci-Fi' },
    { name: 'The Dark Knight', duration: 152, genre: 'Action' },
    { name: 'Interstellar', duration: 169, genre: 'Sci-Fi' },
    { name: 'Oppenheimer', duration: 180, genre: 'Drama' },
    { name: 'Dune: Part Two', duration: 166, genre: 'Sci-Fi' },
    { name: 'Avatar: The Way of Water', duration: 192, genre: 'Action' },
];

const THEATRES = [
    'IMAX Screen 1',
    'Dolby Atmos Hall',
    'Premium Lounge',
];

const SHOW_TIMES = [
    { label: 'Morning', hour: 10, minute: 0 },
    { label: 'Afternoon', hour: 14, minute: 30 },
    { label: 'Evening', hour: 18, minute: 0 },
    { label: 'Night', hour: 21, minute: 30 },
];

async function seed() {
    console.log('Seeding database with multiple movies and showtimes...');

    const client = await pool.connect();
    try {
        // Clear existing data
        await client.query('DELETE FROM booking_requests');
        await client.query('DELETE FROM bookings');
        await client.query('DELETE FROM seats');
        await client.query('DELETE FROM shows');

        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Create shows for each movie with random theatre and showtime assignments
        const showIds: string[] = [];

        for (const movie of MOVIES) {
            // Each movie gets 2-4 showtimes randomly assigned
            const numShowtimes = 2 + Math.floor(Math.random() * 3); // 2-4 showtimes
            const shuffledTimes = [...SHOW_TIMES].sort(() => Math.random() - 0.5);
            const selectedTimes = shuffledTimes.slice(0, numShowtimes);

            for (const showTime of selectedTimes) {
                const theatre = THEATRES[Math.floor(Math.random() * THEATRES.length)];

                // Randomly assign to today or tomorrow
                const date = Math.random() > 0.5 ? today : tomorrow;
                const showDateTime = new Date(date);
                showDateTime.setHours(showTime.hour, showTime.minute, 0, 0);

                // If the time has passed today, move to tomorrow
                if (showDateTime < new Date()) {
                    showDateTime.setDate(showDateTime.getDate() + 1);
                }

                const showResult = await client.query(`
          INSERT INTO shows (movie_name, theatre_name, showtime)
          VALUES ($1, $2, $3)
          RETURNING id;
        `, [movie.name, theatre, showDateTime]);

                const showId = showResult.rows[0].id;
                showIds.push(showId);

                // Create 10x10 seat grid for each show
                const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
                const seatValues: string[] = [];

                for (const row of rows) {
                    for (let num = 1; num <= 10; num++) {
                        seatValues.push(`('${showId}', '${row}', ${num}, 'AVAILABLE')`);
                    }
                }

                await client.query(`
          INSERT INTO seats (show_id, row_label, seat_number, status)
          VALUES ${seatValues.join(', ')};
        `);

                console.log(`  ✓ ${movie.name} @ ${theatre} - ${showTime.label} (${showDateTime.toLocaleString()})`);
            }
        }

        console.log(`\nSeeding completed! Created ${showIds.length} shows with 100 seats each.`);
    } catch (error) {
        console.error('Seeding failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

seed().catch(console.error);
