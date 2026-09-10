import type { Show, Seat, HoldResponse, ConfirmResponse } from './types';

// Use relative paths - Vite proxy will forward to backend
const API_BASE = '';

export async function fetchShows(): Promise<Show[]> {
    const response = await fetch(`${API_BASE}/shows`);
    const data = await response.json();
    return data.shows;
}

export async function fetchSeats(showId: string, userId: string): Promise<Seat[]> {
    const response = await fetch(`${API_BASE}/shows/${showId}/seats?userId=${userId}`);
    const data = await response.json();
    return data.seats;
}

export async function holdSeat(
    showId: string,
    seatId: string,
    userId: string
): Promise<HoldResponse> {
    const response = await fetch(`${API_BASE}/seats/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, seatId, userId }),
    });
    return response.json();
}

export async function confirmBooking(
    showId: string,
    seatId: string,
    userId: string
): Promise<ConfirmResponse> {
    const requestId = crypto.randomUUID();
    const response = await fetch(`${API_BASE}/seats/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, seatId, userId, requestId }),
    });
    return response.json();
}
