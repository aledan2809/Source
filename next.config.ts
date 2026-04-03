import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',

  // Security headers
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'origin-when-cross-origin',
          },
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
        ],
      },
    ];
  },

  serverExternalPackages: ['ai-router'],

  // Environment variables validation
  env: {
    NEMO_GUARDRAILS_PORT: process.env.NEMO_GUARDRAILS_PORT || '7779',
    MAX_CLARIFICATION_ROUNDS: process.env.MAX_CLARIFICATION_ROUNDS || '3',
    CLAUDE_TIMEOUT_MS: process.env.CLAUDE_TIMEOUT_MS || '120000',
    MAX_FILE_SIZE_MB: process.env.MAX_FILE_SIZE_MB || '10',
  },
};

export default nextConfig;
