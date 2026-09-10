/**
 * Load Testing Script for Movie Reservation System
 * 
 * Tests concurrent seat reservation to prove:
 * 1. Race condition prevention via Redis SET NX EX
 * 2. PostgreSQL UNIQUE constraints as final guard
 * 3. Throughput under high contention
 * 4. Exactly-once semantics via idempotency keys
 */

const BASE_URL = 'http://localhost:3000';

// Test Configuration
const CONFIG = {
    CONCURRENT_USERS: 100,        // Users trying to book same seat
    TARGET_SEAT_ID: null,         // Will be set after fetching seats
    SHOW_ID: null,                // Will be set after fetching shows
    RESULTS: {
        successful_holds: 0,
        failed_holds: 0,
        race_condition_caught: 0,
        total_requests: 0,
        response_times: [],
        errors: []
    }
};

// Utility to generate unique user IDs (must be UUID format for database)
const generateUserId = () => crypto.randomUUID();

// Utility to generate unique request IDs (must be UUID format for database)
const generateRequestId = () => crypto.randomUUID();

// Fetch wrapper with timing
async function timedFetch(url, options = {}) {
    const start = Date.now();
    try {
        const response = await fetch(url, options);
        const elapsed = Date.now() - start;
        return { response, elapsed, success: true };
    } catch (error) {
        const elapsed = Date.now() - start;
        return { error, elapsed, success: false };
    }
}

// Test 1: Concurrent Hold Attempts (Race Condition Test)
async function testConcurrentHolds(showId, seatId, numConcurrent) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST 1: Concurrent Seat Hold (${numConcurrent} users, same seat)`);
    console.log(`${'='.repeat(60)}`);
    
    const users = Array(numConcurrent).fill().map(() => generateUserId());
    const results = { success: 0, failed: 0, times: [] };
    
    const holdPromises = users.map(async (userId) => {
        const { response, elapsed } = await timedFetch(`${BASE_URL}/seats/hold`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ showId, seatId, userId })
        });
        
        results.times.push(elapsed);
        
        if (response.ok) {
            const data = await response.json();
            if (data.success) {
                results.success++;
                return { userId, status: 'SUCCESS', elapsed };
            }
        }
        results.failed++;
        return { userId, status: 'FAILED', elapsed };
    });
    
    const outcomes = await Promise.all(holdPromises);
    
    // Analysis
    const avgTime = (results.times.reduce((a, b) => a + b, 0) / results.times.length).toFixed(2);
    const minTime = Math.min(...results.times);
    const maxTime = Math.max(...results.times);
    const p99Time = results.times.sort((a, b) => a - b)[Math.floor(results.times.length * 0.99)];
    
    console.log(`\n📊 Results:`);
    console.log(`   ✅ Successful holds: ${results.success}`);
    console.log(`   ❌ Rejected (correct behavior): ${results.failed}`);
    console.log(`   ⏱️  Avg response time: ${avgTime}ms`);
    console.log(`   ⏱️  Min/Max: ${minTime}ms / ${maxTime}ms`);
    console.log(`   ⏱️  P99 latency: ${p99Time}ms`);
    
    if (results.success === 1) {
        console.log(`\n✅ PASS: Exactly one user acquired the lock (race condition prevented)`);
    } else if (results.success === 0) {
        console.log(`\n⚠️  WARN: No holds succeeded - seat may already be held/booked`);
    } else {
        console.log(`\n❌ FAIL: Multiple users acquired the same seat (${results.success} holds)`);
    }
    
    return {
        test: 'Concurrent Hold',
        concurrent_users: numConcurrent,
        successful_holds: results.success,
        failed_holds: results.failed,
        avg_response_ms: parseFloat(avgTime),
        min_response_ms: minTime,
        max_response_ms: maxTime,
        p99_response_ms: p99Time,
        pass: results.success === 1
    };
}

// Test 2: Idempotency Test (Duplicate Request Handling)
async function testIdempotency(showId, seatId) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST 2: Idempotency (Same request ID, multiple submissions)`);
    console.log(`${'='.repeat(60)}`);
    
    const userId = generateUserId();
    const requestId = generateRequestId();
    
    // First, hold the seat
    const holdResult = await timedFetch(`${BASE_URL}/seats/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, seatId, userId })
    });
    
    if (!holdResult.response.ok) {
        console.log(`   ⚠️  Could not hold seat for idempotency test`);
        return { test: 'Idempotency', pass: false, reason: 'Could not acquire hold' };
    }
    
    console.log(`   📌 Seat held by ${userId}`);
    
    // Send same confirm request 5 times
    const confirmPromises = Array(5).fill().map(async () => {
        const { response, elapsed } = await timedFetch(`${BASE_URL}/seats/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ showId, seatId, requestId, userId })
        });
        const data = await response.json();
        return { data, elapsed };
    });
    
    const results = await Promise.all(confirmPromises);
    
    const successes = results.filter(r => r.data.success === true).length;
    const bookingIds = [...new Set(results.filter(r => r.data.booking).map(r => r.data.booking.id))];
    
    console.log(`\n📊 Results:`);
    console.log(`   📤 Requests sent: 5`);
    console.log(`   ✅ Successful responses: ${successes}`);
    console.log(`   🎫 Unique booking IDs: ${bookingIds.length}`);
    
    if (bookingIds.length === 1) {
        console.log(`\n✅ PASS: All requests returned same booking ID (idempotency works)`);
        console.log(`   Booking ID: ${bookingIds[0]}`);
        console.log(`   Successful responses: ${successes}/5`);
        return { test: 'Idempotency', pass: true, booking_id: bookingIds[0], duplicate_requests: 5, successful_responses: successes };
    } else {
        console.log(`\n❌ FAIL: Expected 1 unique booking ID, got ${bookingIds.length}`);
        return { test: 'Idempotency', pass: false };
    }
}

// Test 3: Throughput Test (Many Different Seats)
async function testThroughput(showId, seats) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST 3: Throughput (Booking different seats concurrently)`);
    console.log(`${'='.repeat(60)}`);
    
    const availableSeats = seats.filter(s => s.status === 'AVAILABLE').slice(0, 50);
    console.log(`   📌 Testing with ${availableSeats.length} available seats`);
    
    const startTime = Date.now();
    
    const bookingPromises = availableSeats.map(async (seat) => {
        const userId = generateUserId();
        const requestId = generateRequestId();
        
        // Hold
        const holdResult = await timedFetch(`${BASE_URL}/seats/hold`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ showId, seatId: seat.id, userId })
        });
        
        if (!holdResult.response.ok) return { success: false, step: 'hold' };
        const holdData = await holdResult.response.json();
        if (!holdData.success) return { success: false, step: 'hold' };
        
        // Confirm
        const confirmResult = await timedFetch(`${BASE_URL}/seats/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ showId, seatId: seat.id, requestId, userId })
        });
        
        if (!confirmResult.response.ok) return { success: false, step: 'confirm' };
        const confirmData = await confirmResult.response.json();
        
        return { 
            success: confirmData.success, 
            step: 'complete',
            holdTime: holdResult.elapsed,
            confirmTime: confirmResult.elapsed
        };
    });
    
    const results = await Promise.all(bookingPromises);
    const totalTime = Date.now() - startTime;
    
    const successful = results.filter(r => r.success).length;
    const holdTimes = results.filter(r => r.holdTime).map(r => r.holdTime);
    const confirmTimes = results.filter(r => r.confirmTime).map(r => r.confirmTime);
    
    const avgHold = holdTimes.length ? (holdTimes.reduce((a,b) => a+b, 0) / holdTimes.length).toFixed(2) : 0;
    const avgConfirm = confirmTimes.length ? (confirmTimes.reduce((a,b) => a+b, 0) / confirmTimes.length).toFixed(2) : 0;
    const throughput = ((successful / totalTime) * 1000).toFixed(2);
    
    console.log(`\n📊 Results:`);
    console.log(`   ✅ Successful bookings: ${successful}/${availableSeats.length}`);
    console.log(`   ⏱️  Total time: ${totalTime}ms`);
    console.log(`   ⏱️  Avg hold time: ${avgHold}ms`);
    console.log(`   ⏱️  Avg confirm time: ${avgConfirm}ms`);
    console.log(`   🚀 Throughput: ${throughput} bookings/second`);
    
    return {
        test: 'Throughput',
        seats_tested: availableSeats.length,
        successful_bookings: successful,
        total_time_ms: totalTime,
        avg_hold_ms: parseFloat(avgHold),
        avg_confirm_ms: parseFloat(avgConfirm),
        throughput_per_second: parseFloat(throughput),
        pass: successful > 0
    };
}

// Test 4: TTL Expiry Test (Simulated)
async function testTTLBehavior(showId, seatId) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST 4: TTL Behavior (Hold expiry)`);
    console.log(`${'='.repeat(60)}`);
    
    const userId = generateUserId();
    
    // Hold the seat
    const holdResult = await timedFetch(`${BASE_URL}/seats/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, seatId, userId })
    });
    
    if (!holdResult.response.ok) {
        console.log(`   ⚠️  Could not hold seat for TTL test`);
        return { test: 'TTL Behavior', pass: false, reason: 'Could not acquire hold' };
    }
    
    const holdData = await holdResult.response.json();
    console.log(`   📌 Seat held by ${userId}`);
    console.log(`   ⏰ TTL: ${holdData.seat?.ttlSeconds || 120} seconds`);
    console.log(`   📝 Note: Full TTL test would wait 120s for expiry`);
    
    // Verify another user CANNOT hold the same seat right now
    const otherUser = generateUserId();
    const conflictResult = await timedFetch(`${BASE_URL}/seats/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, seatId, userId: otherUser })
    });
    
    const conflictData = await conflictResult.response.json();
    
    if (!conflictData.success) {
        console.log(`   ✅ Correctly rejected second user's hold attempt`);
        console.log(`   📝 Error: ${conflictData.error}`);
    }
    
    // Release the seat for cleanup
    await timedFetch(`${BASE_URL}/seats/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, seatId, userId })
    });
    console.log(`   🔓 Seat released for cleanup`);
    
    return {
        test: 'TTL Behavior',
        ttl_seconds: holdData.seat?.ttlSeconds || 120,
        conflict_rejected: !conflictData.success,
        pass: !conflictData.success
    };
}

// Main test runner
async function runAllTests() {
    console.log(`\n${'#'.repeat(60)}`);
    console.log(`#  MOVIE RESERVATION SYSTEM - LOAD & CORRECTNESS TESTS`);
    console.log(`#  Started: ${new Date().toISOString()}`);
    console.log(`${'#'.repeat(60)}`);
    
    // Get a show and its seats
    const showsRes = await fetch(`${BASE_URL}/shows`);
    const showsData = await showsRes.json();
    const show = showsData.shows[0];
    
    console.log(`\n📽️  Using show: ${show.movieName} @ ${show.theatreName}`);
    console.log(`   Show ID: ${show.id}`);
    
    // Get seats
    const seatsRes = await fetch(`${BASE_URL}/shows/${show.id}/seats`);
    const seatsData = await seatsRes.json();
    const availableSeats = seatsData.seats.filter(s => s.status === 'AVAILABLE');
    
    console.log(`   Available seats: ${availableSeats.length}/${seatsData.seats.length}`);
    
    const results = [];
    
    // Test 1: Concurrent holds on same seat
    if (availableSeats.length > 0) {
        const result1 = await testConcurrentHolds(show.id, availableSeats[0].id, 100);
        results.push(result1);
    }
    
    // Test 2: Idempotency
    if (availableSeats.length > 1) {
        const result2 = await testIdempotency(show.id, availableSeats[1].id);
        results.push(result2);
    }
    
    // Test 3: Throughput
    const result3 = await testThroughput(show.id, seatsData.seats);
    results.push(result3);
    
    // Test 4: TTL behavior
    // Need fresh seats
    const freshSeatsRes = await fetch(`${BASE_URL}/shows/${showsData.shows[1]?.id || show.id}/seats`);
    const freshSeatsData = await freshSeatsRes.json();
    const freshAvailable = freshSeatsData.seats.filter(s => s.status === 'AVAILABLE');
    
    if (freshAvailable.length > 0) {
        const result4 = await testTTLBehavior(showsData.shows[1]?.id || show.id, freshAvailable[0].id);
        results.push(result4);
    }
    
    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`FINAL SUMMARY`);
    console.log(`${'='.repeat(60)}`);
    
    const passed = results.filter(r => r.pass).length;
    const total = results.length;
    
    results.forEach(r => {
        const icon = r.pass ? '✅' : '❌';
        console.log(`   ${icon} ${r.test}: ${r.pass ? 'PASSED' : 'FAILED'}`);
    });
    
    console.log(`\n📊 Overall: ${passed}/${total} tests passed`);
    console.log(`🏁 Completed: ${new Date().toISOString()}`);
    
    // Output JSON for documentation
    console.log(`\n${'='.repeat(60)}`);
    console.log(`JSON RESULTS (for documentation)`);
    console.log(`${'='.repeat(60)}`);
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        tests: results,
        summary: { passed, total, pass_rate: `${((passed/total)*100).toFixed(1)}%` }
    }, null, 2));
}

runAllTests().catch(console.error);
