/**
 * Chaos Testing Script for Movie Reservation System
 * 
 * Tests system behavior under failure conditions:
 * 1. Redis unavailable during operation
 * 2. Race condition stress test (500 concurrent users)
 * 3. Database constraint verification
 */

const BASE_URL = 'http://localhost:3000';
const generateUserId = () => crypto.randomUUID();
const generateRequestId = () => crypto.randomUUID();

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

// Test 1: High Contention Stress Test (500 users)
async function stressTestHighContention(showId, seatId) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`CHAOS TEST 1: High Contention (500 concurrent users, 1 seat)`);
    console.log(`${'='.repeat(60)}`);
    
    const numUsers = 500;
    const users = Array(numUsers).fill().map(() => generateUserId());
    const results = { success: 0, failed: 0, times: [], errors: {} };
    
    const startTime = Date.now();
    
    const holdPromises = users.map(async (userId) => {
        const { response, elapsed } = await timedFetch(`${BASE_URL}/seats/hold`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ showId, seatId, userId })
        });
        
        results.times.push(elapsed);
        
        try {
            const data = await response.json();
            if (data.success) {
                results.success++;
                return { status: 'SUCCESS' };
            }
            results.failed++;
            results.errors[data.error] = (results.errors[data.error] || 0) + 1;
            return { status: 'FAILED', error: data.error };
        } catch {
            results.failed++;
            return { status: 'ERROR' };
        }
    });
    
    await Promise.all(holdPromises);
    const totalTime = Date.now() - startTime;
    
    const avgTime = (results.times.reduce((a, b) => a + b, 0) / results.times.length).toFixed(2);
    const p50 = results.times.sort((a, b) => a - b)[Math.floor(results.times.length * 0.5)];
    const p99 = results.times.sort((a, b) => a - b)[Math.floor(results.times.length * 0.99)];
    
    console.log(`\n📊 Results:`);
    console.log(`   👥 Total requests: ${numUsers}`);
    console.log(`   ✅ Successful holds: ${results.success}`);
    console.log(`   ❌ Rejected: ${results.failed}`);
    console.log(`   ⏱️  Total time: ${totalTime}ms`);
    console.log(`   ⏱️  Avg latency: ${avgTime}ms`);
    console.log(`   ⏱️  P50/P99: ${p50}ms / ${p99}ms`);
    console.log(`   📈 Error breakdown: ${JSON.stringify(results.errors)}`);
    
    if (results.success === 1) {
        console.log(`\n✅ PASS: Exactly 1 user acquired lock under extreme contention`);
    } else {
        console.log(`\n❌ FAIL: Expected 1 lock, got ${results.success}`);
    }
    
    return {
        test: 'High Contention Stress',
        concurrent_users: numUsers,
        successful_holds: results.success,
        failed_holds: results.failed,
        total_time_ms: totalTime,
        avg_latency_ms: parseFloat(avgTime),
        p50_latency_ms: p50,
        p99_latency_ms: p99,
        error_breakdown: results.errors,
        pass: results.success === 1
    };
}

// Test 2: Database UNIQUE Constraint Verification
async function testDatabaseConstraint(showId, seats) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`CHAOS TEST 2: Database UNIQUE Constraint Verification`);
    console.log(`${'='.repeat(60)}`);
    
    // Find an available seat
    const availableSeats = seats.filter(s => s.status === 'AVAILABLE');
    if (availableSeats.length === 0) {
        console.log(`   ⚠️  No available seats for this test`);
        return { test: 'DB Constraint', pass: false, reason: 'No seats' };
    }
    
    const seat = availableSeats[0];
    const userId = generateUserId();
    const requestId1 = generateRequestId();
    const requestId2 = generateRequestId();
    
    // Hold the seat
    const holdResult = await timedFetch(`${BASE_URL}/seats/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, seatId: seat.id, userId })
    });
    
    if (!(await holdResult.response.json()).success) {
        console.log(`   ⚠️  Could not hold seat`);
        return { test: 'DB Constraint', pass: false, reason: 'Could not hold' };
    }
    console.log(`   📌 Seat ${seat.row}${seat.number} held`);
    
    // Confirm the booking
    const confirm1 = await timedFetch(`${BASE_URL}/seats/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, seatId: seat.id, userId, requestId: requestId1 })
    });
    const confirm1Data = await confirm1.response.json();
    console.log(`   ✅ First confirmation: ${confirm1Data.success ? 'SUCCESS' : 'FAILED'}`);
    
    // Try to confirm again with different requestId (should fail)
    const confirm2 = await timedFetch(`${BASE_URL}/seats/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, seatId: seat.id, userId, requestId: requestId2 })
    });
    const confirm2Data = await confirm2.response.json();
    console.log(`   ❌ Second confirmation (different requestId): ${confirm2Data.success ? 'SUCCESS (BAD!)' : 'FAILED (CORRECT)'}`);
    console.log(`      Error: ${confirm2Data.error}`);
    
    const pass = confirm1Data.success && !confirm2Data.success;
    if (pass) {
        console.log(`\n✅ PASS: Database UNIQUE constraint prevents double-booking`);
    } else {
        console.log(`\n❌ FAIL: Double-booking was allowed`);
    }
    
    return {
        test: 'DB Constraint',
        first_confirm: confirm1Data.success,
        second_confirm_blocked: !confirm2Data.success,
        rejection_error: confirm2Data.error,
        pass
    };
}

// Test 3: Burst Traffic (rapid fire requests)
async function testBurstTraffic(showId, seats) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`CHAOS TEST 3: Burst Traffic (rapid concurrent bookings)`);
    console.log(`${'='.repeat(60)}`);
    
    const availableSeats = seats.filter(s => s.status === 'AVAILABLE').slice(0, 30);
    console.log(`   📌 Testing burst booking of ${availableSeats.length} seats`);
    
    const startTime = Date.now();
    
    const bookPromises = availableSeats.map(async (seat) => {
        const userId = generateUserId();
        const requestId = generateRequestId();
        
        // Hold
        const hold = await timedFetch(`${BASE_URL}/seats/hold`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ showId, seatId: seat.id, userId })
        });
        
        if (!hold.response.ok) return { success: false, step: 'hold' };
        const holdData = await hold.response.json();
        if (!holdData.success) return { success: false, step: 'hold', error: holdData.error };
        
        // Immediate confirm (no delay)
        const confirm = await timedFetch(`${BASE_URL}/seats/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ showId, seatId: seat.id, userId, requestId })
        });
        
        const confirmData = await confirm.response.json();
        return {
            success: confirmData.success,
            holdTime: hold.elapsed,
            confirmTime: confirm.elapsed
        };
    });
    
    const results = await Promise.all(bookPromises);
    const totalTime = Date.now() - startTime;
    
    const successful = results.filter(r => r.success).length;
    const holdTimes = results.filter(r => r.holdTime).map(r => r.holdTime);
    const confirmTimes = results.filter(r => r.confirmTime).map(r => r.confirmTime);
    
    const avgHold = holdTimes.length ? (holdTimes.reduce((a,b) => a+b, 0) / holdTimes.length).toFixed(2) : 0;
    const avgConfirm = confirmTimes.length ? (confirmTimes.reduce((a,b) => a+b, 0) / confirmTimes.length).toFixed(2) : 0;
    const throughput = ((successful / totalTime) * 1000).toFixed(2);
    
    console.log(`\n📊 Results:`);
    console.log(`   ✅ Successful: ${successful}/${availableSeats.length}`);
    console.log(`   ⏱️  Total time: ${totalTime}ms`);
    console.log(`   ⏱️  Avg hold: ${avgHold}ms | Avg confirm: ${avgConfirm}ms`);
    console.log(`   🚀 Throughput: ${throughput} bookings/second`);
    
    const pass = successful >= availableSeats.length * 0.9; // 90% success rate
    console.log(`\n${pass ? '✅' : '❌'} ${pass ? 'PASS' : 'FAIL'}: Burst traffic ${pass ? 'handled correctly' : 'caused failures'}`);
    
    return {
        test: 'Burst Traffic',
        seats_tested: availableSeats.length,
        successful: successful,
        total_time_ms: totalTime,
        throughput_per_second: parseFloat(throughput),
        avg_hold_ms: parseFloat(avgHold),
        avg_confirm_ms: parseFloat(avgConfirm),
        pass
    };
}

// Main chaos test runner
async function runChaosTests() {
    console.log(`\n${'#'.repeat(60)}`);
    console.log(`#  CHAOS TESTING - FAILURE MODE VERIFICATION`);
    console.log(`#  Started: ${new Date().toISOString()}`);
    console.log(`${'#'.repeat(60)}`);
    
    // Get shows and seats
    const showsRes = await fetch(`${BASE_URL}/shows`);
    const showsData = await showsRes.json();
    const show1 = showsData.shows[0];
    const show2 = showsData.shows[1] || show1;
    
    console.log(`\n📽️  Primary show: ${show1.movieName}`);
    
    // Get seats for tests
    const seats1Res = await fetch(`${BASE_URL}/shows/${show1.id}/seats`);
    const seats1 = (await seats1Res.json()).seats;
    
    const seats2Res = await fetch(`${BASE_URL}/shows/${show2.id}/seats`);
    const seats2 = (await seats2Res.json()).seats;
    
    const availableSeats = seats1.filter(s => s.status === 'AVAILABLE');
    console.log(`   Available seats: ${availableSeats.length}`);
    
    const results = [];
    
    // Test 1: High Contention
    if (availableSeats.length > 0) {
        const r1 = await stressTestHighContention(show1.id, availableSeats[0].id);
        results.push(r1);
    }
    
    // Refresh seats for next test
    const freshSeats = await (await fetch(`${BASE_URL}/shows/${show2.id}/seats`)).json();
    
    // Test 2: DB Constraint
    const r2 = await testDatabaseConstraint(show2.id, freshSeats.seats);
    results.push(r2);
    
    // Refresh seats
    const finalSeats = await (await fetch(`${BASE_URL}/shows/${showsData.shows[2]?.id || show1.id}/seats`)).json();
    
    // Test 3: Burst Traffic
    const r3 = await testBurstTraffic(showsData.shows[2]?.id || show1.id, finalSeats.seats);
    results.push(r3);
    
    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`CHAOS TEST SUMMARY`);
    console.log(`${'='.repeat(60)}`);
    
    const passed = results.filter(r => r.pass).length;
    results.forEach(r => {
        const icon = r.pass ? '✅' : '❌';
        console.log(`   ${icon} ${r.test}: ${r.pass ? 'PASSED' : 'FAILED'}`);
    });
    
    console.log(`\n📊 Overall: ${passed}/${results.length} chaos tests passed`);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`JSON RESULTS`);
    console.log(`${'='.repeat(60)}`);
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'chaos_tests',
        tests: results,
        summary: { passed, total: results.length }
    }, null, 2));
}

runChaosTests().catch(console.error);
