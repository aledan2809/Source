'use client';

export const dynamic = 'force-dynamic';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ro">
      <body
        style={{
          backgroundColor: '#0a0a0a',
          color: '#f97316',
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          margin: '0',
        }}
      >
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>
            A aparut o eroare
          </h2>
          <p style={{ color: '#9ca3af', marginBottom: '1.5rem' }}>
            {error?.message || 'Eroare necunoscuta'}
          </p>
          <a
            href="/"
            style={{
              backgroundColor: '#f97316',
              color: '#fff',
              padding: '0.75rem 1.5rem',
              borderRadius: '0.5rem',
              textDecoration: 'none',
              fontSize: '1rem',
              display: 'inline-block',
            }}
          >
            Inapoi acasa
          </a>
        </div>
      </body>
    </html>
  );
}
