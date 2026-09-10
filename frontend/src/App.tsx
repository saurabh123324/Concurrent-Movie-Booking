import { useState, useEffect, useCallback } from 'react';
import './index.css';
import type { Show, Seat, MovieGroup } from './types';
import { fetchShows, fetchSeats, holdSeat, confirmBooking } from './api';

// Generate a stable user ID for this session
const USER_ID = crypto.randomUUID();

// Movie emoji mapping
const MOVIE_EMOJIS: Record<string, string> = {
  'Inception': '🌀',
  'The Dark Knight': '🦇',
  'Interstellar': '🚀',
  'Oppenheimer': '💣',
  'Dune: Part Two': '🏜️',
  'Avatar: The Way of Water': '🌊',
};

function App() {
  const [shows, setShows] = useState<Show[]>([]);
  const [selectedMovie, setSelectedMovie] = useState<string | null>(null);
  const [selectedShow, setSelectedShow] = useState<Show | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selectedSeat, setSelectedSeat] = useState<Seat | null>(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<{ id: number; message: string; type: 'success' | 'error' }[]>([]);

  // Load shows on mount
  useEffect(() => {
    fetchShows()
      .then(setShows)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Poll seats when a show is selected
  useEffect(() => {
    if (!selectedShow) return;

    const loadSeats = () => {
      fetchSeats(selectedShow.id, USER_ID).then(setSeats).catch(console.error);
    };

    loadSeats();
    const interval = setInterval(loadSeats, 2000);
    return () => clearInterval(interval);
  }, [selectedShow]);

  // Check if our selected seat is still valid
  useEffect(() => {
    if (!selectedSeat) return;

    const seat = seats.find(s => s.id === selectedSeat.id);
    if (!seat || seat.status === 'BOOKED' || (seat.status === 'HELD' && seat.heldBy !== USER_ID)) {
      setSelectedSeat(null);
    }
  }, [seats, selectedSeat]);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  }, []);

  // Group shows by movie
  const movieGroups: MovieGroup[] = shows.reduce((acc: MovieGroup[], show) => {
    const existing = acc.find(g => g.movieName === show.movieName);
    if (existing) {
      existing.shows.push(show);
    } else {
      acc.push({ movieName: show.movieName, shows: [show] });
    }
    return acc;
  }, []);

  // Format time
  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const handleSeatClick = async (seat: Seat) => {
    if (seat.status !== 'AVAILABLE') return;
    if (selectedSeat) {
      showToast('You already have a seat selected', 'error');
      return;
    }

    const result = await holdSeat(selectedShow!.id, seat.id, USER_ID);
    if (result.success) {
      setSelectedSeat(seat);
      showToast(`Seat ${seat.row}${seat.number} selected!`, 'success');
    } else {
      const messages: Record<string, string> = {
        'SEAT_ALREADY_HELD': 'This seat was just taken by another user',
        'SEAT_ALREADY_BOOKED': 'This seat is already booked',
      };
      showToast(messages[result.error!] || 'Could not select seat', 'error');
    }
  };

  const handleConfirm = async () => {
    if (!selectedSeat || !selectedShow) return;

    const result = await confirmBooking(selectedShow.id, selectedSeat.id, USER_ID);
    if (result.success) {
      showToast(`Booking confirmed! Seat ${selectedSeat.row}${selectedSeat.number}`, 'success');
      setSelectedSeat(null);
    } else {
      const messages: Record<string, string> = {
        'LOCK_NOT_OWNED': 'Your selection expired. Please try again.',
        'SEAT_ALREADY_BOOKED': 'This seat was just booked by another user',
      };
      showToast(messages[result.error!] || 'Booking failed', 'error');
      setSelectedSeat(null);
    }
  };

  const goBack = () => {
    if (selectedShow) {
      setSelectedShow(null);
      setSelectedSeat(null);
      setSeats([]);
    } else if (selectedMovie) {
      setSelectedMovie(null);
    }
  };

  // Render movie list
  if (!selectedMovie) {
    return (
      <>
        <header className="header">
          <div className="container header-content">
            <div className="logo">
              <span className="logo-icon">🎬</span>
              CineBook
            </div>
          </div>
        </header>

        <main className="main container">
          <h1 className="page-title">Now Showing</h1>

          {loading ? (
            <div className="loading">Loading movies...</div>
          ) : (
            <div className="movies-grid">
              {movieGroups.map(group => {
                const nextShow = group.shows.sort((a, b) =>
                  new Date(a.showtime).getTime() - new Date(b.showtime).getTime()
                )[0];

                return (
                  <div
                    key={group.movieName}
                    className="movie-card"
                    onClick={() => setSelectedMovie(group.movieName)}
                  >
                    <div className="movie-poster">
                      {MOVIE_EMOJIS[group.movieName] || '🎥'}
                    </div>
                    <div className="movie-info">
                      <h3 className="movie-name">{group.movieName}</h3>
                      <p className="movie-theatre">{group.shows.length} showtime{group.shows.length > 1 ? 's' : ''} available</p>
                      <span className="movie-time">
                        Next: {formatDate(nextShow.showtime)} at {formatTime(nextShow.showtime)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>

        <ToastContainer toasts={toasts} />
      </>
    );
  }

  // Render showtime selection
  const movieShows = shows
    .filter(s => s.movieName === selectedMovie)
    .sort((a, b) => new Date(a.showtime).getTime() - new Date(b.showtime).getTime());

  if (!selectedShow) {
    return (
      <>
        <header className="header">
          <div className="container header-content">
            <div className="logo">
              <span className="logo-icon">🎬</span>
              CineBook
            </div>
          </div>
        </header>

        <main className="main container">
          <div className="showtimes-section">
            <div className="showtimes-header">
              <button className="back-button" onClick={goBack}>
                ← Back to movies
              </button>
            </div>

            <h1 className="page-title">{selectedMovie}</h1>

            <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-6)' }}>
              Select a showtime
            </p>

            <div className="showtimes-grid">
              {movieShows.map(show => (
                <button
                  key={show.id}
                  className="showtime-chip"
                  onClick={() => setSelectedShow(show)}
                >
                  <div style={{ fontWeight: 600 }}>{formatTime(show.showtime)}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    {formatDate(show.showtime)} • {show.theatreName}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </main>

        <ToastContainer toasts={toasts} />
      </>
    );
  }

  // Render seat selection
  const rows = [...new Set(seats.map(s => s.row))].sort();

  return (
    <>
      <header className="header">
        <div className="container header-content">
          <div className="logo">
            <span className="logo-icon">🎬</span>
            CineBook
          </div>
        </div>
      </header>

      <main className="main container">
        <div className="showtimes-header">
          <button className="back-button" onClick={goBack}>
            ← Back to showtimes
          </button>
        </div>

        <h1 className="page-title" style={{ marginBottom: 'var(--space-2)' }}>
          {selectedMovie}
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-6)' }}>
          {selectedShow.theatreName} • {formatDate(selectedShow.showtime)} at {formatTime(selectedShow.showtime)}
        </p>

        <div className="seat-section">
          <div className="screen">Screen</div>

          <div className="legend">
            <div className="legend-item">
              <div className="legend-dot available" />
              <span>Available</span>
            </div>
            <div className="legend-item">
              <div className="legend-dot held" />
              <span>Held</span>
            </div>
            <div className="legend-item">
              <div className="legend-dot booked" />
              <span>Booked</span>
            </div>
            <div className="legend-item">
              <div className="legend-dot selected" />
              <span>Your Selection</span>
            </div>
          </div>

          <div className="seat-grid">
            {rows.map(row => (
              <>
                <div key={`label-${row}`} className="row-label">{row}</div>
                {seats
                  .filter(s => s.row === row)
                  .sort((a, b) => a.number - b.number)
                  .map(seat => {
                    let className = 'seat ';
                    if (selectedSeat?.id === seat.id) {
                      className += 'selected';
                    } else if (seat.status === 'BOOKED') {
                      className += 'booked';
                    } else if (seat.status === 'HELD') {
                      className += 'held';
                    } else {
                      className += 'available';
                    }

                    return (
                      <button
                        key={seat.id}
                        className={className}
                        onClick={() => handleSeatClick(seat)}
                        disabled={seat.status !== 'AVAILABLE' && selectedSeat?.id !== seat.id}
                      >
                        {seat.number}
                      </button>
                    );
                  })}
              </>
            ))}
          </div>

          {selectedSeat && (
            <div className="selection-summary">
              <div className="selection-info">
                <h4>Your Selection</h4>
                <p>Seat {selectedSeat.row}{selectedSeat.number}</p>
              </div>
              <button className="btn btn-primary" onClick={handleConfirm}>
                Confirm Booking
              </button>
            </div>
          )}
        </div>
      </main>

      <ToastContainer toasts={toasts} />
    </>
  );
}

function ToastContainer({ toasts }: { toasts: { id: number; message: string; type: string }[] }) {
  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast ${toast.type}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

export default App;
