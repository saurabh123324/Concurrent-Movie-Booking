# Movie Reservation System

A minimal but correct backend credibility demo showing concurrent seat selection, time-bound seat holds, distributed locking, and failure safety.

![Demo Preview](docs/demo-preview.png)

## 🎯 What This Demonstrates

- **Concurrent Seat Selection**: Two users can't book the same seat
- **Time-Bound Holds**: Seats auto-release after 120 seconds
- **Distributed Locking**: Redis SET NX EX for atomic locks
- **PostgreSQL Authority**: Database UNIQUE constraints as final guard
- **Failure Safety**: Graceful handling of crashes, timeouts, retries

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- (Or local PostgreSQL 15+ and Redis 7+)

### With Docker (Recommended)

```bash
# Start PostgreSQL + Redis
docker compose up -d

# Install dependencies
npm install

# Run database migrations
npm run migrate

# Seed initial data
npm run seed

# Start the server
npm run dev
```

### Without Docker (Manual Setup)

1. **PostgreSQL**: Create database `movie_reservation` with user `movies`/`movies123`
2. **Redis**: Run on default port 6379
3. Follow remaining steps above

### Demo It!

1. Open http://localhost:3000 in **two browser windows** side by side
2. Click the same seat in both windows simultaneously
3. **Watch**: One succeeds (yellow), one fails (error toast)
4. Wait 120 seconds or click "Confirm Booking"
5. **Watch**: Seat turns red (booked) in both windows

## 📁 Project Structure

```
movie-reservation/
├── docker-compose.yml      # PostgreSQL + Redis
├── src/
│   ├── index.ts            # Express server entry
│   ├── config.ts           # Environment configuration
│   ├── db/
│   │   ├── connection.ts   # PostgreSQL pool
│   │   ├── migrations.ts   # Schema setup
│   │   └── seed.ts         # Initial data
│   ├── redis/
│   │   ├── client.ts       # Redis connection
│   │   └── locks.ts        # Distributed lock utilities
│   ├── services/
│   │   ├── seatService.ts  # Seat hold/release logic
│   │   └── bookingService.ts # Booking confirmation
│   ├── routes/
│   │   ├── shows.ts        # Show endpoints
│   │   └── seats.ts        # Seat endpoints
│   └── types/
│       └── index.ts        # TypeScript interfaces
├── frontend/
│   ├── index.html          # Seat grid page
│   ├── styles.css          # Modern styling
│   └── app.js              # Polling + UI logic
└── docs/
    └── ARCHITECTURE.md     # Full technical documentation
```

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/shows` | List all shows |
| GET | `/shows/:showId` | Get show details |
| GET | `/shows/:showId/seats` | Get seats with status |
| POST | `/seats/hold` | Hold a seat (Redis lock) |
| POST | `/seats/release` | Release a held seat |
| POST | `/seats/confirm` | Confirm booking (DB transaction) |

## 🔐 Key Concepts

### Redis (Advisory Locks)
```typescript
// Atomic lock acquisition
redis.set(key, userId, 'EX', 120, 'NX');
// NX = Only if not exists
// EX 120 = Expire after 120 seconds
```

### PostgreSQL (Final Authority)
```sql
-- UNIQUE constraint prevents double-booking
ALTER TABLE bookings ADD UNIQUE (seat_id);
```

## 📖 Documentation

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for:
- Complete architecture overview
- Redis vs PostgreSQL responsibility split
- Concurrency model explanation
- Failure handling matrix
- Known race windows & tradeoffs
- Scaling considerations
- Interview defense section

## 🎓 Interview Defense

> "We use a hybrid locking approach. Redis provides fast advisory locks for instant UI feedback. PostgreSQL is the final authority with UNIQUE constraints. When they disagree, PostgreSQL wins. This gives us the speed of Redis and the correctness guarantees of ACID transactions."

For the full interview preparation guide, see the [Architecture docs](docs/ARCHITECTURE.md#how-i-would-explain-this-system-in-an-interview).

## 📝 License

MIT
