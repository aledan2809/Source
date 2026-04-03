# Source — AI Sourcing Platform

AI-powered procurement platform that helps you find suppliers, generate RFQ documents, and create personalized emails. Describe what you need to buy or rent, and get complete sourcing packages.

## 🚀 Features

- **Smart AI Interpretation** — Clarifying questions until 100% understanding
- **Complete Sourcing Packages** — Suppliers + RFQ + Emails + PDF Brief
- **Real Web Search** — Finds actual product URLs and prices
- **Feedback Loop** — Refine results based on your feedback
- **Dashboard** — Statistics and search history
- **File Upload Support** — Attach specs, drawings, images
- **Multi-language Support** — Romanian interface, global sourcing

## 🛠️ Tech Stack

- **Frontend**: Next.js 16 + React 19 + TypeScript + Tailwind CSS
- **Backend**: Next.js API routes
- **AI**: Anthropic Claude via Claude CLI
- **Data**: JSON file storage (MVP) with atomic operations
- **Security**: Middleware authentication, rate limiting, input validation

## ⚡ Getting Started

### Prerequisites

- Node.js 18+
- Claude CLI installed and authenticated
- (Optional) NeMo Guardrails running on port 7779

### Installation

1. **Clone and install dependencies:**
   ```bash
   cd C:/Projects/source
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your settings
   ```

3. **Run the development server:**
   ```bash
   npm run dev
   ```

4. **Open in browser:**
   ```
   http://localhost:3030
   ```

### Authentication (Optional)

Set `ACCESS_TOKEN` in `.env.local` to require authentication:
```bash
ACCESS_TOKEN=your_secret_token_here
```

Without this variable, the app is publicly accessible (development mode).

## 📁 Project Structure

```
src/
├── app/                    # Next.js App Router
│   ├── page.tsx           # Main sourcing form
│   ├── dashboard/         # Statistics dashboard
│   ├── results/[id]/      # Results page with tabs
│   └── api/               # API routes
│       ├── source/        # Main sourcing endpoints
│       └── upload/        # File upload
├── lib/                   # Shared utilities
│   ├── claude.ts         # Claude CLI wrapper
│   ├── validation.ts     # Input validation + rate limiting
│   └── file-operations.ts # Safe file operations with locking
├── data/                  # JSON data storage
│   ├── search-log.json   # All searches log
│   ├── results/          # Individual result files
│   └── ai-learnings.json # Feedback patterns
└── middleware.ts         # Authentication middleware
```

## 🔧 Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ACCESS_TOKEN` | No | (none) | Authentication token - if unset, app is public |
| `NEMO_GUARDRAILS_PORT` | No | 7779 | Port for NeMo Guardrails service |
| `CLAUDE_TIMEOUT_MS` | No | 120000 | Claude CLI timeout in milliseconds |
| `MAX_FILE_SIZE_MB` | No | 10 | Maximum file size for uploads |
| `MAX_CLARIFICATION_ROUNDS` | No | 3 | Maximum AI clarification rounds |

### Rate Limits

- **Interpret API**: 10 requests/minute per IP
- **Generate API**: 3 requests/minute per IP (more expensive)
- **Upload API**: 20 uploads/minute per IP

## 🔒 Security Features

- **Authentication middleware** with token-based access control
- **Rate limiting** on all API endpoints
- **Input validation** with detailed error messages
- **File upload restrictions** (size, type, count)
- **Safe file operations** with atomic writes (prevents race conditions)
- **Security headers** via Next.js config
- **No hardcoded credentials** — Claude CLI uses its own session

## 📊 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/source/interpret` | POST | AI interpretation + clarifications |
| `/api/source/generate` | POST | Generate sourcing package |
| `/api/source/results/[id]` | GET | Get result by ID |
| `/api/source/feedback` | POST | Submit user feedback |
| `/api/source/dashboard` | GET | Statistics for dashboard |
| `/api/upload` | POST | File upload handler |

## 🧪 Data Flow

1. **User submits** sourcing form with description + details
2. **AI interprets** requirement, asks clarifying questions (max 3 rounds)
3. **Background generation** starts — user navigated to results page
4. **Results page polls** every 3 seconds until complete
5. **User provides feedback** — can regenerate with improvements
6. **Dashboard tracks** all searches and success rates

## 📈 Recent Security & Performance Improvements

✅ **Fixed in v2.0** (March 2026):
- Added authentication middleware with ACCESS_TOKEN
- Implemented rate limiting on all API endpoints
- Added server-side input validation
- Fixed race conditions in JSON file operations with atomic writes
- Extracted duplicate code into shared utilities
- Added security headers via Next.js config
- Updated metadata and branding
- Added comprehensive error handling

## 🛡️ Production Considerations

For production deployment, consider:

- **Database migration** — Replace JSON files with PostgreSQL/MongoDB
- **Redis for rate limiting** — Replace in-memory store
- **Full authentication** — Replace token auth with OAuth/JWT
- **File storage** — Move uploads to S3/CloudFlare
- **Monitoring** — Add APM and error tracking
- **CI/CD pipeline** — Automated testing and deployment

## 📝 License

Private project for internal use.

---

*Built with ❤️ and powered by Claude AI*