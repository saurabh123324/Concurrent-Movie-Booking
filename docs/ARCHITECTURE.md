# Movie Reservation System - Architecture Documentation

A minimal but correct backend credibility demo showing concurrent seat selection, time-bound seat holds, distributed locking, and failure safety.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Redis vs PostgreSQL Responsibility Split](#redis-vs-postgresql-responsibility-split)
3. [Concurrency Model](#concurrency-model)
4. [Failure Handling](#failure-handling)
5. [Known Race Windows](#known-race-windows)
6. [Scaling Considerations](#scaling-considerations)
7. [Interview Defense Section](#how-i-would-explain-this-system-in-an-interview)

---

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐
│   Browser 1     │     │   Browser 2     │
│  (User Alice)   │     │   (User Bob)    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │  HTTP (Poll + POST)   │
         └───────────┬───────────┘
                     ▼
         ┌───────────────────────┐
         │   Express API Server  │
         │   (Stateless)         │
         └───────────┬───────────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│     Redis       │     │   PostgreSQL    │
│  (Advisory)     │     │  (Authoritative)│
│                 │     │                 │
│ • Fast locks    │     │ • Source of     │
│ • TTL-based     │     │   truth         │
│ • SET NX EX     │     │ • UNIQUE        │
│                 │     │   constraints   │
│ If Redis says   │     │ DB always wins  │
│ yes, it's a     │     │                 │
│ suggestion      │     │                 │
└─────────────────┘     └─────────────────┘
```

### Key Principle

**Redis is advisory, PostgreSQL is authoritative.**

- Redis provides fast, atomic locks for immediate UI feedback
- PostgreSQL enforces correctness via UNIQUE constraints and transactions
- When they disagree, PostgreSQL wins

---

## Redis vs PostgreSQL Responsibility Split

| Aspect | Redis | PostgreSQL |
|--------|-------|------------|
| **Purpose** | Speed & UX | Correctness & Durability |
| **Seat Locks** | SET NX EX (atomic, fast) | FOR UPDATE (transactional) |
| **TTL Management** | Automatic expiry | Periodic cleanup |
| **Double-booking Prevention** | Advisory (can't guarantee) | UNIQUE constraint (guaranteed) |
| **Crash Recovery** | Lock auto-expires | State persists |
| **Scale** | Shardable | Read replicas |

### Why This Split?

1. **User Experience**: Redis responds in <1ms. Users see instant feedback.
2. **Correctness**: PostgreSQL UNIQUE constraints make double-booking impossible.
3. **Fault Tolerance**: If Redis dies, DB still prevents corruption.
4. **Simplicity**: Clear mental model - Redis for speed, DB for truth.

---

## Concurrency Model

### Optimistic vs Pessimistic Locking

We use **pessimistic locking** with a twist:

```
Pessimistic (Traditional)    Our Hybrid Approach
┌─────────────────────┐      ┌─────────────────────┐
│ Lock row in DB      │      │ Lock in Redis       │ ← Fast (1ms)
│ Do work             │      │ Update DB status    │
│ Unlock row          │      │ On confirm:         │
└─────────────────────┘      │   Transaction +     │
                             │   FOR UPDATE        │ ← Correct
                             └─────────────────────┘
```

**Why hybrid?**
- Pure optimistic: Conflicts discovered late, bad UX
- Pure pessimistic in DB: Too slow for seat selection
- Hybrid: Fast feedback + guaranteed correctness

### The Hold → Confirm Flow

```
1. User clicks seat
   └─→ POST /seats/hold
       ├─→ Check DB: Is seat BOOKED? → Fail fast
       ├─→ Redis: SET seat:{show}:{id} {userId} NX EX 120
       │   └─→ NX = Only if Not eXists (atomic)
       │   └─→ EX 120 = Expire after 120 seconds
       └─→ Update DB: status=HELD, held_by={userId}

2. User clicks confirm (within 120s)
   └─→ POST /seats/confirm
       ├─→ Check idempotency key (booking_requests table)
       ├─→ Verify Redis lock ownership
       └─→ DB Transaction:
           ├─→ BEGIN
           ├─→ SELECT ... FOR UPDATE (lock row)
           ├─→ Verify status=HELD and held_by=userId
           ├─→ INSERT booking (UNIQUE constraint = final guard)
           ├─→ UPDATE seat status=BOOKED
           └─→ COMMIT
```

---

## Failure Handling

### Scenario Matrix

| Scenario | What Happens | Recovery |
|----------|--------------|----------|
| **User holds seat → server crashes** | Redis lock has TTL | Lock expires after 120s, seat auto-available |
| **Redis TTL expires mid-flow** | User still has DB hold | Confirm fails with LOCK_NOT_OWNED, user re-holds |
| **Duplicate confirmation request** | Idempotency key exists | Return cached result from booking_requests |
| **Redis unavailable** | API returns 503 | Client retries; DB still prevents corruption |
| **DB UNIQUE violation** | Transaction rollback | Return SEAT_ALREADY_BOOKED |
| **Network timeout on confirm** | Client retries with same requestId | Idempotent - same result returned |

### Idempotency Implementation

```sql
-- Client provides unique requestId (UUID)
-- First request: Creates PENDING record, completes booking, marks COMPLETED
-- Retry with same requestId: Returns cached booking result

INSERT INTO booking_requests (request_id, seat_id, status)
VALUES ($1, $2, 'PENDING')
ON CONFLICT (request_id) DO NOTHING;

-- If already exists, check status and return cached result
```

### Periodic Cleanup

```typescript
// Every 30 seconds, clean up stale holds in PostgreSQL
// WHY: Redis TTL handles lock expiry, but DB status needs syncing
UPDATE seats 
SET status = 'AVAILABLE', held_by = NULL 
WHERE status = 'HELD' AND held_until < NOW();
```

---

## Known Race Windows

### Window 1: Redis Lock → DB Update

```
Timeline:
0ms   - Alice acquires Redis lock (seat A5)
1ms   - Bob reads DB (sees A5 as AVAILABLE - stale!)
2ms   - Alice updates DB (seat A5 → HELD)
3ms   - Bob tries to hold A5
        └─→ Redis SET NX fails → Bob correctly rejected
```

**Why acceptable?** Bob's Redis attempt fails immediately. The DB read was stale but harmless because the Redis lock is the gatekeeper for holds.

### Window 2: Redis Expires Before DB Update

```
Timeline:
0s    - Alice holds seat (Redis TTL = 120s)
120s  - Redis lock expires
121s  - Cleanup hasn't run yet
121s  - Bob reads DB (sees seat as HELD by Alice)
```

**Why acceptable?** 
- If Bob tries to hold: Redis lock succeeds
- If Alice tries to confirm: LOCK_NOT_OWNED (Redis check)
- Eventually consistent within 30 seconds

### Window 3: Confirm During Redis Expiry

```
Timeline:
119.9s - Alice clicks confirm
119.9s - Server checks Redis lock ownership → OK
120.0s - Redis lock expires (TTL)
120.1s - Transaction begins
120.2s - DB verifies held_by = Alice → OK
120.3s - Booking created
```

**Why acceptable?** The DB transaction uses FOR UPDATE to lock the row. Even if Redis expired, the DB held_by check is authoritative within the transaction.

---

## Scaling Considerations

### Current Architecture (Single Instance)

```
1 API Server → 1 Redis → 1 PostgreSQL
```

Handles: ~1000 concurrent users, ~500 req/sec

### Horizontal Scaling Path

```
         ┌─────────┐
         │  Load   │
         │Balancer │
         └────┬────┘
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
┌───────┐ ┌───────┐ ┌───────┐
│ API 1 │ │ API 2 │ │ API 3 │  ← Stateless, easy to scale
└───┬───┘ └───┬───┘ └───┬───┘
    │         │         │
    └─────────┼─────────┘
              │
    ┌─────────┼─────────┐
    ▼                   ▼
┌───────────┐   ┌───────────────┐
│ Redis     │   │ PostgreSQL    │
│ Cluster   │   │ + Read        │
│           │   │   Replicas    │
└───────────┘   └───────────────┘
```

### What Changes at Scale?

| Component | Current | At Scale |
|-----------|---------|----------|
| API Servers | 1 | N (stateless, behind LB) |
| Redis | Single | Cluster (sharded by showId) |
| PostgreSQL | Single | Primary + Read Replicas |
| Seat Polling | HTTP polling | WebSockets or SSE |
| Cleanup | In-process timer | Separate worker process |

---

## How I Would Explain This System in an Interview

### 1. Concurrency Model

> "We use a hybrid locking approach. Redis provides fast advisory locks using SET NX EX - the NX means 'only set if not exists' which is atomic, and EX sets a TTL. This gives users instant feedback when they click a seat. But Redis is just advisory - the real protection is PostgreSQL's UNIQUE constraint on the bookings table. Even if Redis fails, the database won't allow two bookings for the same seat."

### 2. Failure Handling

> "The system is designed to fail safely. If a user holds a seat and the server crashes, the Redis lock has a 120-second TTL so it auto-expires. If Redis itself goes down, we return 503 and the client retries - but importantly, the database still prevents double-booking. For network failures during confirmation, we use an idempotency key so retries are safe."

### 3. Why Node.js is Acceptable

> "Node.js is fine here because the actual concurrency safety is delegated to Redis and PostgreSQL. Node's event loop efficiently handles many concurrent I/O operations - it's waiting on database and Redis responses, not doing CPU-intensive work. The single-threaded nature of Redis actually helps us - SET NX is guaranteed atomic because Redis processes commands sequentially."

### 4. Why Redis is Advisory

> "I call Redis 'advisory' because it can't guarantee correctness on its own. Redis data can be lost (even with persistence), TTLs can expire at inconvenient times, and Redis doesn't have ACID transactions. It's great for fast coordination, but the database must have the final word. Think of Redis as a bouncer checking IDs at the door, but the database is the official guest list."

### 5. Why PostgreSQL is Authoritative

> "PostgreSQL is authoritative because of ACID guarantees. The UNIQUE constraint on bookings.seat_id makes double-booking impossible at the database level. We use transactions with FOR UPDATE to lock rows during the confirmation flow. Even if every other part of the system fails, as long as the database is up, we can't corrupt the booking data."

### 6. Scaling Considerations

> "The API servers are stateless so horizontal scaling is trivial - just add more behind a load balancer. For Redis, we'd move to a cluster sharded by show ID. PostgreSQL scaling is trickier - we'd add read replicas for the seat status queries, keeping writes on the primary. At very high scale, we might consider a separate database per theatre or show date. The polling endpoint would become WebSocket or Server-Sent Events to reduce load."

---

## Quick Start

```bash
# Start infrastructure
docker-compose up -d

# Wait for services to be healthy
docker-compose ps

# Install dependencies
npm install

# Run migrations
npm run migrate

# Seed initial data
npm run seed

# Start the server
npm run dev

# Open http://localhost:3000 in two browser windows
# Click the same seat in both - watch mutual exclusion in action!
```
