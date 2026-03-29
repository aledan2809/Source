import { NextRequest, NextResponse } from 'next/server';

// Note: middleware runs on Edge runtime, cannot import node-only logger
// Using console directly here is acceptable

/**
 * Authentication middleware with production enforcement
 * Uses ACCESS_TOKEN environment variable for protection
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip auth for static files
  if (pathname.startsWith('/_next') ||
      pathname === '/favicon.ico') {
    return NextResponse.next();
  }

  // Health check is always public (needed for monitoring)
  if (pathname === '/api/health') {
    return NextResponse.next();
  }

  // Check for ACCESS_TOKEN environment variable
  const requiredToken = process.env.ACCESS_TOKEN;

  // If no ACCESS_TOKEN is set, app is public (log warning in production)
  if (!requiredToken) {
    if (process.env.NODE_ENV === 'production') {
      // Log once per startup, not per request (handled by health endpoint)
    }
    return NextResponse.next();
  }

  // Check for authorization
  const authHeader = request.headers.get('authorization');
  const urlToken = request.nextUrl.searchParams.get('token');
  const cookieToken = request.cookies.get('access-token')?.value;

  const providedToken = authHeader?.replace('Bearer ', '') || urlToken || cookieToken;

  if (providedToken === requiredToken) {
    // Valid token - set cookie for future requests if not present
    const response = NextResponse.next();
    if (!cookieToken) {
      response.cookies.set('access-token', providedToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7 days
      });
    }
    return response;
  }

  // Authentication required
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Authentication required. Set ACCESS_TOKEN header or cookie.' },
      { status: 401 }
    );
  }

  // For pages, return a simple auth form
  return new Response(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Source - Authentication Required</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body {
            font-family: system-ui, -apple-system, sans-serif;
            background: #0f172a;
            color: white;
            margin: 0;
            padding: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .auth-form {
            background: #1e293b;
            padding: 2rem;
            border-radius: 1rem;
            border: 1px solid #334155;
            min-width: 300px;
          }
          .logo {
            text-align: center;
            font-size: 2rem;
            font-weight: bold;
            margin-bottom: 1rem;
            background: linear-gradient(to right, #f97316, #dc2626);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
          }
          input {
            width: 100%;
            padding: 0.75rem;
            background: #334155;
            border: 1px solid #475569;
            border-radius: 0.5rem;
            color: white;
            margin: 0.5rem 0;
          }
          button {
            width: 100%;
            padding: 0.75rem;
            background: linear-gradient(to right, #f97316, #dc2626);
            border: none;
            border-radius: 0.5rem;
            color: white;
            font-weight: bold;
            cursor: pointer;
            margin-top: 1rem;
          }
          button:hover {
            opacity: 0.9;
          }
          .error {
            color: #ef4444;
            text-align: center;
            margin-top: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="auth-form">
          <div class="logo">Source</div>
          <form method="GET">
            <label>Access Token:</label>
            <input type="password" name="token" placeholder="Enter access token..." required>
            <button type="submit">Authenticate</button>
          </form>
          ${urlToken && providedToken !== requiredToken ? '<div class="error">Invalid access token</div>' : ''}
        </div>
      </body>
    </html>
  `, {
    headers: { 'Content-Type': 'text/html' },
    status: 401,
  });
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};