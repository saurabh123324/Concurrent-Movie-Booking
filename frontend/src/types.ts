// API Types for Movie Reservation System

export interface Show {
    id: string;
    movieName: string;
    theatreName: string;
    showtime: string;
    createdAt: string;
}

export interface Seat {
    id: string;
    row: string;
    number: number;
    status: 'AVAILABLE' | 'HELD' | 'BOOKED';
    heldBy?: string;
    ttlSeconds?: number;
}

export interface HoldResponse {
    success: boolean;
    seat?: Seat;
    expiresAt?: string;
    error?: string;
}

export interface ConfirmResponse {
    success: boolean;
    booking?: {
        id: string;
        seatId: string;
        confirmedAt: string;
    };
    error?: string;
}

// Group shows by movie
export interface MovieGroup {
    movieName: string;
    shows: Show[];
}
