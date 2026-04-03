# Source — AI Sourcing Platform

## Stack
- **Frontend**: Next.js 16 + React 19 + TypeScript + Tailwind CSS
- **Backend**: Next.js API routes
- **AI**: Anthropic Claude (claude-sonnet-4-5-20250929) via API
- **Port**: 3030
- **Location**: D:\Projects\source

---

## What is Source?

Source is an AI-powered procurement/sourcing platform. The user describes what they need to buy or rent, and the AI:
1. Asks clarifying questions until it understands the requirement 100%
2. Generates a **Sourcing Package** containing ALL of the following:
   - List of recommended suppliers (with names, website, contact info, notes)
   - RFQ (Request for Quotation) document — professional, ready to send
   - Draft email to each supplier (personalized per supplier)
   - PDF-ready sourcing brief (use browser print or a lib like @react-pdf/renderer)

---

## Core UI Features

### Sourcing Form (`/` or `/new`)
All fields on a single clean page:

1. **Free text description** (large textarea)
   - Label: "Descrie ce cauți"
   - Placeholder: "Ex: Am nevoie de un strung CNC pentru piese mici, toleranțe de 0.01mm..."
   - The AI reads this and may ask up to 3 rounds of follow-up questions before proceeding

2. **Buy vs Rental** (radio group)
   - Options: `Cumpărare` | `Închiriere`

3. **Condition** (radio group, shown only when Buy is selected)
   - Options: `Nou` | `Second-hand` | `Indiferent`

4. **Zone** (radio group)
   - `Local` — city/locality level
   - `Regional` — county / country level
   - `Global` — anywhere in the world

5. **Budget range** (two number inputs + currency select)
   - Min budget — Max budget
   - Currency: RON | EUR | USD | GBP
   - Optional (user can leave blank)

6. **Quantity** (number input + unit free text)
   - Ex: 3 bucăți, 500 kg, 1 set
   - Required

7. **Deadline / urgency** (select)
   - ASAP | 1 săptămână | 2 săptămâni | 1 lună | 3 luni | Fără urgență

8. **File uploads** (drag & drop zone)
   - Accept: images, PDF, Word, Excel, DWG
   - Multiple files allowed
   - Files are stored in `/uploads/[session-id]/` and referenced in the AI prompt

---

## AI Interpretation Flow

### Step 1 — Initial understanding
After user submits, call Claude with all form data + uploaded files context.
Claude responds with ONE of:
- `{ "understood": true, "summary": "...", "proceed": true }` — go to step 3
- `{ "understood": false, "questions": ["Q1", "Q2", "Q3"] }` — go to step 2

### Step 2 — Clarification (max 3 rounds)
Show questions to user as a small form. User answers, re-send to Claude.
Loop until `understood: true` or max 3 rounds reached.

### Step 3 — Generate Sourcing Package
Send final understood spec to Claude and ask it to generate:

```json
{
  "summary": "Confirmed understanding of the requirement",
  "suppliers": [
    {
      "name": "Supplier Name",
      "website": "https://...",
      "email": "contact@...",
      "phone": "+40...",
      "country": "Romania",
      "notes": "Specializat în CNC de precizie"
    }
  ],
  "rfq": "Full RFQ document text...",
  "emails": [
    {
      "to": "contact@supplier.com",
      "subject": "...",
      "body": "..."
    }
  ],
  "brief": "Sourcing brief in markdown format"
}
```

---

## Pages & Routes

- `/` — Home / new sourcing request (the form)
- `/results/[id]` — Results page showing the full Sourcing Package
- `GET /api/source/interpret` — AI interpretation call
- `POST /api/source/generate` — Generate full sourcing package
- `POST /api/upload` — File upload handler

---

## Results Page (`/results/[id]`)

Tabs or sections:
1. **Furnizori** — cards with supplier info + copy email button
2. **RFQ** — full document, copyable, download button
3. **Email-uri** — one email per supplier, copyable
4. **Brief PDF** — printable sourcing brief

---

## Design

- Dark theme (bg-gray-950, cards bg-gray-900)
- Primary accent: orange (#f97316)
- Clean, professional, minimal
- Mobile responsive
- Romanian language UI

---

## Environment Variables

```env
ANTHROPIC_API_KEY=        # from C:\Projects\Master\credentials\.env.shared
NEXT_PUBLIC_APP_URL=http://localhost:3030
```

---

## MANDATORY RULES

1. All API keys come from `C:\Projects\Master\credentials\.env.shared` — never hardcode
2. All development goes through AI Pipeline mesh
3. Update knowledge/ after every significant feature
4. Port: **3030**
