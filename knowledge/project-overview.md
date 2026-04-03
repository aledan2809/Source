# Source — Project Overview

## What it does
AI-powered sourcing/procurement platform. User describes what they need → AI clarifies → generates full Sourcing Package (suppliers + RFQ + emails + PDF brief).

## Stack
- Next.js 16 + React 19 + TypeScript + Tailwind CSS
- Anthropic Claude API for AI interpretation and generation
- Port 3030

## Key user inputs
- Free text description (AI-interpreted)
- Buy vs Rental
- Condition: New / Second-hand / Either (buy only)
- Zone: Local / Regional / Global
- Budget range + currency (RON/EUR/USD/GBP)
- Quantity + unit
- Deadline/urgency
- File uploads (specs, photos, DWGs)

## AI output — Sourcing Package
1. Confirmed requirement summary
2. Supplier list (name, website, email, phone, notes)
3. RFQ document (ready to send)
4. Draft emails per supplier
5. PDF-ready sourcing brief

## Phases
- [ ] Phase 1: Sourcing form UI + file upload
- [ ] Phase 2: AI interpretation loop (clarification)
- [ ] Phase 3: Generate sourcing package
- [ ] Phase 4: Results page (suppliers, RFQ, emails, brief)
