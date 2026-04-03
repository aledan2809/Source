export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    process.on('unhandledRejection', (reason) => {
      console.error('[Instrumentation] Unhandled Rejection:', reason);
    });

    process.on('uncaughtException', (error) => {
      console.error('[Instrumentation] Uncaught Exception:', error);
    });

    // Validate critical environment variables at startup
    const requiredVars = ['ANTHROPIC_API_KEY'];
    const warnVars = ['GOOGLE_CSE_API_KEY', 'GOOGLE_CSE_CX'];

    for (const v of requiredVars) {
      if (!process.env[v]) {
        console.error(`[Instrumentation] CRITICAL: Missing required env var: ${v}`);
      }
    }

    for (const v of warnVars) {
      if (!process.env[v]) {
        console.warn(`[Instrumentation] WARNING: Missing env var ${v} — Google CSE product URL search will be disabled`);
      }
    }
  }
}
