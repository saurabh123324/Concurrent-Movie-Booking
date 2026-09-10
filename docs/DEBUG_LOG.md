# Movie Reservation System - Debug Log & Error Resolution

## Session: 2026-01-02

---

## Error 1: Docker Unavailable

**Log:**
```
zsh: command not found: docker
```

**Root Cause:** Docker daemon was not installed/running on the system.

**Resolution:** 
- Pivoted to Homebrew-managed services
- Detected `postgresql@15` and `redis` running via `brew services list`
- Used local PostgreSQL instance instead of containerized environment

**Command Used:**
```bash
brew services list
# Output showed:
# postgresql@15 started revanthsuddala
# redis         started revanthsuddala
```

---

## Error 2: Port 3000 Already In Use

**Log:**
```
Error: listen EADDRINUSE: address already in use :::3000
    at Server.setupListenHandle [as _listen2] (node:net:1940:16)
    code: 'EADDRINUSE',
    errno: -48,
    syscall: 'listen',
    port: 3000
```

**Root Cause:** Previous server instance was still bound to TCP port 3000.

**Resolution:**
```bash
lsof -ti :3000 | xargs kill -9
```
- Sent SIGKILL to the process holding the socket
- Restarted server successfully

---

## Error 3: Invalid UUID Type for userId

**Log:**
```
Error: invalid input syntax for type uuid: "user_1767348832996_tzfex9bd9"
    severity: 'ERROR',
    code: '22P02',
    file: 'uuid.c',
    routine: 'string_to_uuid'
```

**Root Cause:** 
- PostgreSQL schema defined `held_by UUID` and `user_id UUID` columns
- Test script was generating string-formatted user IDs: `user_${Date.now()}_${random}`
- PostgreSQL's `uuid` type requires RFC 4122 compliant UUIDs

**Schema Definition (from migrations.ts):**
```sql
CREATE TABLE seats (
    ...
    held_by UUID,  -- Expects valid UUID, not arbitrary string
    ...
);

CREATE TABLE bookings (
    ...
    user_id UUID NOT NULL,  -- Expects valid UUID
    ...
);
```

**Resolution:**
Changed ID generation from:
```javascript
const generateUserId = () => `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
```

To:
```javascript
const generateUserId = () => crypto.randomUUID();
```

- `crypto.randomUUID()` generates RFC 4122 v4 compliant UUIDs
- Example output: `8cc66399-4429-4d84-8f0f-08a5eb21ab8e`

---

## Error 4: Stale Redis Locks

**Log:**
```
{"success":false,"error":"SEAT_ALREADY_HELD"}
```

**Root Cause:**
- Previous test runs left orphaned locks in Redis
- Redis keys `seat:{showId}:{seatId}` persisted with TTL not yet expired
- `SET NX` (set-if-not-exists) correctly rejected new lock attempts

**Resolution:**
```bash
redis-cli FLUSHALL
```
- Atomic flush of all Redis databases
- Clears all key-value pairs including stale locks
- Followed by database reseed for clean state

---

## Error 5: userId Sent as Header Instead of Body

**Initial Test Code:**
```javascript
const holdResult = await timedFetch(`${BASE_URL}/seats/hold`, {
    method: 'POST',
    headers: { 
        'Content-Type': 'application/json',
        'X-User-ID': userId  // WRONG: API doesn't read this header
    },
    body: JSON.stringify({ showId, seatId })  // Missing userId in body
});
```

**API Validation (from seats.ts):**
```typescript
const { showId, seatId, userId } = req.body as HoldSeatRequest;

if (!showId || !seatId || !userId) {
    res.status(400).json({
        success: false,
        error: 'Missing required fields: showId, seatId, userId'
    });
}
```

**Resolution:**
```javascript
const holdResult = await timedFetch(`${BASE_URL}/seats/hold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ showId, seatId, userId })  // userId in request body
});
```

---

## Error 6: Redis Client Disconnection After FLUSHALL

**Log:**
```
HTTP/1.1 500 Internal Server Error
{"success":false,"error":"Internal server error"}
```

**Root Cause:**
- `redis-cli FLUSHALL` disrupted the connection pool
- Node.js `ioredis` client entered error state
- Subsequent Redis operations failed silently

**Resolution:**
- Server was already running with `tsx watch` (hot-reload)
- The watch process detected file changes and reconnected
- Alternative: restart the server process after FLUSHALL

---

## Final Successful Test Sequence

```bash
# 1. Flush Redis to clear stale locks
redis-cli FLUSHALL

# 2. Reseed database with fresh data
DB_USER=revanthsuddala DB_PASSWORD="" npm run seed

# 3. Run load tests (100 concurrent users)
node tests/load-test.js

# 4. Flush again, reseed, run chaos tests (500 concurrent users)
redis-cli FLUSHALL && npm run seed && node tests/chaos-test.js
```

---

## Test Results After All Fixes

### Load Tests (4/4 PASSED)
```json
{
  "Concurrent Hold": { "concurrent_users": 100, "successful_holds": 1, "pass": true },
  "Idempotency": { "duplicate_requests": 5, "unique_booking": 1, "pass": true },
  "Throughput": { "throughput_per_second": 888.89, "pass": true },
  "TTL Behavior": { "conflict_rejected": true, "pass": true }
}
```

### Chaos Tests (3/3 PASSED)
```json
{
  "High Contention": { "concurrent_users": 500, "successful_holds": 1, "pass": true },
  "DB Constraint": { "double_booking_blocked": true, "pass": true },
  "Burst Traffic": { "throughput_per_second": 666.67, "pass": true }
}
```
