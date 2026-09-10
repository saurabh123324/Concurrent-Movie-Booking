# Testing Methodology - Technical Documentation

## Architecture Under Test

```
┌─────────────────────────────────────────────────────────────────┐
│                      TEST HARNESS (Node.js)                      │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Promise.all([...N concurrent fetch() calls])          │   │
│   │  • Parallel HTTP request dispatch                       │   │
│   │  • Timing instrumentation via Date.now() deltas        │   │
│   │  • Response aggregation and statistical analysis       │   │
│   └─────────────────────────────────────────────────────────┘   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTP/1.1 POST
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      EXPRESS API SERVER                          │
│   • Single-threaded event loop (libuv)                          │
│   • Connection pooling to PostgreSQL (pg-pool, max=20)          │
│   • Persistent Redis connection (ioredis)                       │
└───────────────────┬─────────────────────┬───────────────────────┘
                    ▼                     ▼
        ┌───────────────────┐   ┌───────────────────┐
        │      REDIS        │   │   POSTGRESQL      │
        │  SET NX EX lock   │   │  FOR UPDATE lock  │
        │  Single-threaded  │   │  MVCC + row locks │
        └───────────────────┘   └───────────────────┘
```

---

## Test 1: Concurrent Hold (Race Condition Verification)

### Objective
Validate that Redis `SET NX EX` provides atomic mutual exclusion under high contention.

### Mechanism

```javascript
const users = Array(100).fill().map(() => crypto.randomUUID());

const holdPromises = users.map(async (userId) => {
    return fetch(`${BASE_URL}/seats/hold`, {
        method: 'POST',
        body: JSON.stringify({ showId, seatId, userId })
    });
});

const results = await Promise.all(holdPromises);
```

### Execution Flow

1. **Parallel Dispatch**: 100 `fetch()` calls initiated simultaneously via `Promise.all()`
2. **TCP Connection Pooling**: Node.js HTTP agent multiplexes requests over keep-alive connections
3. **Server-Side Queueing**: Express receives requests; event loop processes them sequentially within each tick
4. **Redis Contention Point**:
   ```
   SET seat:{showId}:{seatId} {userId} NX EX 120
   ```
   - `NX` (Not eXists): Atomic compare-and-swap semantics
   - Only the first request to reach Redis wins
   - Subsequent requests receive `null` response (lock not acquired)

5. **Timing Instrumentation**:
   ```javascript
   const start = Date.now();
   const response = await fetch(...);
   const elapsed = Date.now() - start;
   ```

### Expected Behavior
- **Exactly 1 `success: true`**: First request to execute `SET NX` wins
- **99 `SEAT_ALREADY_HELD`**: Subsequent requests fail at Redis layer (fast-fail)

### Why This Works
Redis is single-threaded. All commands are serialized through a single execution thread. `SET NX` is atomic—no TOCTOU (time-of-check-to-time-of-use) vulnerability exists.

---

## Test 2: Idempotency (Exactly-Once Semantics)

### Objective
Verify that duplicate booking requests with the same `requestId` produce identical results without creating duplicate bookings.

### Mechanism

```javascript
const requestId = crypto.randomUUID();  // Same for all 5 requests

const confirmPromises = Array(5).fill().map(() => 
    fetch(`${BASE_URL}/seats/confirm`, {
        body: JSON.stringify({ showId, seatId, requestId, userId })
    })
);

const results = await Promise.all(confirmPromises);
```

### Server-Side Idempotency Implementation

```sql
-- First request creates PENDING record
INSERT INTO booking_requests (request_id, seat_id, status) 
VALUES ($1, $2, 'PENDING')
ON CONFLICT (request_id) DO NOTHING;

-- Check if already processed
SELECT status, booking_id FROM booking_requests WHERE request_id = $1;
-- If COMPLETED: return cached booking_id
-- If PENDING: proceed with transaction
```

### Execution Flow

1. **First Request Arrives**:
   - Inserts `booking_requests` row with `status = 'PENDING'`
   - Executes booking transaction
   - Updates to `status = 'COMPLETED'`, stores `booking_id`

2. **Concurrent/Subsequent Requests**:
   - `INSERT ... ON CONFLICT DO NOTHING` is a no-op
   - `SELECT` returns existing `booking_id`
   - Returns cached result without re-executing transaction

### Expected Behavior
- **1 unique `booking_id`** returned across all 5 responses
- **No duplicate bookings** in database

---

## Test 3: Throughput (Sustained Load)

### Objective
Measure maximum bookings per second under parallel load.

### Mechanism

```javascript
const startTime = Date.now();

const bookingPromises = availableSeats.map(async (seat) => {
    const holdResult = await fetch('/seats/hold', {...});
    if (!holdResult.success) return { success: false };
    
    const confirmResult = await fetch('/seats/confirm', {...});
    return { success: confirmResult.success, holdTime, confirmTime };
});

const results = await Promise.all(bookingPromises);
const totalTime = Date.now() - startTime;
const throughput = (successful / totalTime) * 1000;  // ops/sec
```

### Calculation

```
Throughput = (Successful Bookings / Total Wall-Clock Time) × 1000

Example:
- 48 successful bookings
- 54ms total time
- Throughput = (48 / 54) × 1000 = 888.89 bookings/second
```

### Latency Metrics

```javascript
const times = results.map(r => r.elapsed).sort((a, b) => a - b);
const p50 = times[Math.floor(times.length * 0.50)];  // Median
const p99 = times[Math.floor(times.length * 0.99)];  // 99th percentile
```

---

## Test 4: TTL Behavior (Time-Bound Holds)

### Objective
Verify that Redis TTL prevents conflicting holds and enables automatic release.

### Mechanism

```javascript
// User A holds seat
await fetch('/seats/hold', { body: { userId: userA } });

// User B attempts hold on same seat
const conflict = await fetch('/seats/hold', { body: { userId: userB } });
// Expected: SEAT_ALREADY_HELD

// User A releases
await fetch('/seats/release', { body: { userId: userA } });
```

### Redis TTL Verification

```bash
redis-cli TTL seat:{showId}:{seatId}
# Returns: seconds remaining (e.g., 118)
```

### Lua-Scripted Atomic Release

```lua
-- Only delete if current owner matches
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0  -- Not owner, don't delete
end
```

---

## Chaos Test 1: High Contention (500 Users)

### Objective
Stress-test lock acquisition under extreme parallelism.

### Mechanism
Same as Test 1, but with `numUsers = 500`.

### Key Observations

| Metric | Value |
|--------|-------|
| Total Requests | 500 |
| Successful Locks | 1 |
| Rejections | 499 |
| Total Time | 300ms |
| P99 Latency | 259ms |

### Analysis
- Linear scaling: 5× users → ~5× latency increase
- Lock accuracy remains 100% (exactly 1 winner)
- Error breakdown: `{"SEAT_ALREADY_HELD": 499}` confirms all rejections are from Redis `NX` semantics

---

## Chaos Test 2: Database UNIQUE Constraint

### Objective
Verify PostgreSQL's `UNIQUE` constraint catches edge cases missed by Redis.

### Scenario
1. **Request A**: Holds seat, confirms with `requestId_A`
2. **Request B**: Attempts confirm with different `requestId_B` on same seat

### Server-Side Protection

```sql
CREATE TABLE bookings (
    seat_id UUID UNIQUE,  -- UNIQUE constraint = final guard
    ...
);
```

Even if Redis lock expired or was bypassed, PostgreSQL will reject:
```
ERROR: duplicate key value violates unique constraint "bookings_seat_id_key"
```

### Test Result
- First confirm: SUCCESS
- Second confirm: `LOCK_NOT_OWNED` (caught at Redis layer before hitting DB)

---

## Chaos Test 3: Burst Traffic

### Objective
Simulate flash-sale scenario with zero-delay sequential booking operations.

### Mechanism

```javascript
// No artificial delay between hold and confirm
const hold = await fetch('/seats/hold', {...});
const confirm = await fetch('/seats/confirm', {...});  // Immediate
```

### Metrics
- 30 seats booked in 45ms
- 100% success rate under burst
- Throughput: 666.67 bookings/second

---

## Statistical Analysis Methods

### Percentile Calculation

```javascript
function percentile(arr, p) {
    const sorted = arr.sort((a, b) => a - b);
    const index = Math.floor(sorted.length * p);
    return sorted[index];
}

const p50 = percentile(times, 0.50);  // Median latency
const p99 = percentile(times, 0.99);  // Tail latency
```

### Throughput Formula

```
Throughput (ops/sec) = N_successful / T_total × 1000

Where:
- N_successful = count of operations where response.success === true
- T_total = wall-clock milliseconds from first dispatch to last response
```

---

## Test Infrastructure

| Component | Technology | Purpose |
|-----------|------------|---------|
| Test Runner | Node.js native | No test framework overhead |
| HTTP Client | `fetch()` API | Built-in, Promise-based |
| Parallelism | `Promise.all()` | Concurrent request dispatch |
| UUID Generation | `crypto.randomUUID()` | RFC 4122 v4 compliant |
| Timing | `Date.now()` | Millisecond-precision wall clock |
| Statistics | Manual calculation | Percentiles, averages |

---

## Reproducibility

```bash
# Clean state
redis-cli FLUSHALL
DB_USER=revanthsuddala DB_PASSWORD="" npm run seed

# Run tests
node tests/load-test.js    # 4 correctness tests
node tests/chaos-test.js   # 3 stress tests
```

All tests are deterministic given clean Redis and database state.
