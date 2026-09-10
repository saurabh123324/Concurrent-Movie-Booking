// TypeScript interfaces for the Movie Reservation System
// WHY: Strong typing catches errors at compile time, not runtime

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'BOOKED';

export interface Show {
    id: string;
    movieName: string;
    theatreName: string;
    showtime: Date;
    createdAt: Date;
}

export interface Seat {
    id: string;
    showId: string;
    rowLabel: string;      // A-J
    seatNumber: number;    // 1-10
    status: SeatStatus;
    heldBy: string | null;
    heldUntil: Date | null;
}

export interface SeatResponse {
    id: string;
    row: string;
    number: number;
    status: SeatStatus;
    heldBy?: string;       // Only included if held by requesting user
    ttlSeconds?: number;   // Remaining hold time
}

export interface Booking {
    id: string;
    seatId: string;
    userId: string;
    confirmedAt: Date;
}

export interface BookingRequest {
    requestId: string;
    seatId: string;
    status: 'PENDING' | 'COMPLETED' | 'FAILED';
    createdAt: Date;
}

// API Request/Response types
export interface HoldSeatRequest {
    showId: string;
    seatId: string;
    userId: string;
}

export interface HoldSeatResponse {
    success: boolean;
    seat?: SeatResponse;
    expiresAt?: string;
    error?: 'SEAT_ALREADY_HELD' | 'SEAT_ALREADY_BOOKED' | 'SEAT_NOT_FOUND' | 'REDIS_UNAVAILABLE';
}

export interface ConfirmBookingRequest {
    showId: string;
    seatId: string;
    userId: string;
    requestId: string; // Idempotency key
}

export interface ConfirmBookingResponse {
    success: boolean;
    booking?: {
        id: string;
        seatId: string;
        confirmedAt: string;
    };
    error?: 'LOCK_NOT_OWNED' | 'SEAT_ALREADY_BOOKED' | 'REQUEST_ALREADY_PROCESSED' | 'SEAT_NOT_FOUND';
}
