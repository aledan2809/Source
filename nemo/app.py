"""
NeMo Guardrails — Sourcing Validation Service
Adapted from Master AI Pipeline (mesh/guardrails/nemo/app.py)

Two-stage validation:
  Stage 1: Local regex rules (fast, <100ms) — budget, fake names, phones, aggregators, zone
  Stage 2: LLM semantic check (1-3s) — asks AI to verify supplier plausibility

Endpoints:
  GET  /health              — Liveness
  GET  /status              — Service info
  POST /validate/sourcing   — Full validation (Stage 1 + Stage 2)
  POST /validate/quick      — Stage 1 only (no LLM, fast)

Port: 7779 (configurable via NEMO_PORT env)
"""

import os
import re
import json
from typing import Optional
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────

NEMO_PORT = int(os.environ.get("NEMO_PORT", "7779"))
# LLM API key for Stage 2 semantic checks (optional — falls back to Stage 1 only)
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

llm_available = bool(OPENAI_API_KEY or ANTHROPIC_API_KEY)

# ── FastAPI ───────────────────────────────────────────────────────────────────

app = FastAPI(title="NeMo Guardrails — Sourcing", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Models ────────────────────────────────────────────────────────────────────

class SupplierInput(BaseModel):
    name: str = ""
    website: str = ""
    productUrl: Optional[str] = ""
    email: str = ""
    phone: str = ""
    country: str = ""
    priceMin: Optional[float] = None
    priceMax: Optional[float] = None
    priceCurrency: Optional[str] = None
    notes: str = ""
    urlVerified: Optional[bool] = False

class ValidateSourcingRequest(BaseModel):
    suppliers: list[SupplierInput]
    budgetMax: Optional[float] = None
    budgetMin: Optional[float] = None
    currency: Optional[str] = "EUR"
    zone: Optional[str] = "regional"
    zoneLocation: Optional[str] = None
    productDescription: Optional[str] = ""
    suspiciouslyLowPriceThreshold: Optional[float] = 0.50

# ── Stage 1: Local Rules (ported from Master) ────────────────────────────────

FAKE_PHONE_PATTERNS = [
    re.compile(r'^\+40\s*XXX'),
    re.compile(r'^0{6,}'),
    re.compile(r'^(\d)\1{7,}'),
    re.compile(r'^\+\d{1,2}\s*000\s*000'),
]

SUSPICIOUS_NAME_PATTERNS = [
    re.compile(r'\b(test|fake|dummy|placeholder|example|lorem|ipsum|furnizor\s+(?:X|A|B|1|2))\b', re.I),
    re.compile(r'^[A-Z]\s*$'),
    re.compile(r'Furnizor\s+\d+$', re.I),
    re.compile(r'Supplier\s+\d+$', re.I),
]

AGGREGATOR_DOMAINS = {
    "olx.ro", "olx.com", "facebook.com", "marketplace.facebook.com",
    "publi24.ro", "alibaba.com", "aliexpress.com", "made-in-china.com",
    "dhgate.com", "wish.com", "temu.com", "okazii.ro", "lajumate.ro",
}

COUNTRY_PHONE_PREFIXES: dict[str, list[str]] = {
    "România": ["+40", "0040", "07", "02", "03"],
    "Romania": ["+40", "0040", "07", "02", "03"],
    "Germania": ["+49", "0049"], "Germany": ["+49", "0049"],
    "Franța": ["+33", "0033"], "France": ["+33", "0033"],
    "Italia": ["+39", "0039"], "Italy": ["+39", "0039"],
    "Ungaria": ["+36", "0036"], "Hungary": ["+36", "0036"],
    "Spania": ["+34", "0034"], "Spain": ["+34", "0034"],
    "Austria": ["+43", "0043"],
    "Poland": ["+48", "0048"], "Polonia": ["+48", "0048"],
}

TO_EUR: dict[str, float] = {
    "EUR": 1.0, "RON": 0.20, "USD": 0.92, "GBP": 1.15, "PLN": 0.23,
}

def _to_eur(amount: float, currency: str) -> float:
    return amount * TO_EUR.get(currency.upper(), 1.0)


def local_check_sourcing(req: ValidateSourcingRequest) -> dict:
    """Stage 1: Fast local regex checks. Same logic as Master NeMo."""
    issues = []
    rejected_indices: list[int] = []
    budget_max_eur = _to_eur(req.budgetMax, req.currency) if req.budgetMax else None
    budget_min_eur = _to_eur(req.budgetMin, req.currency) if req.budgetMin else None
    threshold = req.suspiciouslyLowPriceThreshold or 0.50

    for idx, s in enumerate(req.suppliers):
        flags = []

        # Budget exceeded
        if budget_max_eur and s.priceMin is not None:
            p = _to_eur(s.priceMin, s.priceCurrency or req.currency)
            if p > budget_max_eur * 1.05:
                flags.append({"type": "budget_exceeded", "message": f"priceMin {s.priceMin} > budget max {req.budgetMax} {req.currency}"})
                rejected_indices.append(idx)

        # Suspiciously low price
        if budget_min_eur and s.priceMax is not None:
            p = _to_eur(s.priceMax, s.priceCurrency or req.currency)
            if p < budget_min_eur * threshold:
                flags.append({"type": "price_suspiciously_low", "message": f"priceMax {s.priceMax} is <{int(threshold*100)}% of budget min"})

        # Suspicious name
        for pat in SUSPICIOUS_NAME_PATTERNS:
            if pat.search(s.name or ""):
                flags.append({"type": "suspicious_name", "message": f"Name looks fake: '{s.name}'"})
                rejected_indices.append(idx)
                break

        # Empty name
        if not (s.name or "").strip():
            flags.append({"type": "empty_name", "message": "Empty name"})
            rejected_indices.append(idx)

        # Fake phone
        phone = (s.phone or "").strip()
        if phone:
            for pat in FAKE_PHONE_PATTERNS:
                if pat.search(phone):
                    flags.append({"type": "fake_phone", "message": f"Phone looks fake: '{phone}'"})
                    break
            # Country/phone prefix mismatch
            country = (s.country or "").strip()
            expected = COUNTRY_PHONE_PREFIXES.get(country)
            if expected and not any(phone.startswith(p) for p in expected):
                flags.append({"type": "phone_country_mismatch", "message": f"Phone '{phone}' wrong prefix for {country}"})

        # Aggregator URL
        for url_field in [s.productUrl, s.website]:
            url = (url_field or "").strip()
            if url:
                try:
                    from urllib.parse import urlparse
                    netloc = urlparse(url).netloc.lower().lstrip("www.")
                    if any(netloc == agg or netloc.endswith("." + agg) for agg in AGGREGATOR_DOMAINS):
                        flags.append({"type": "aggregator_url", "message": f"URL points to aggregator: {netloc}"})
                except Exception:
                    pass

        # No contact data
        if not s.website and not s.email and not s.phone and not s.productUrl:
            flags.append({"type": "no_contact_data", "message": "No contact data"})
            rejected_indices.append(idx)

        # Zone mismatch
        cl = (s.country or "").lower()
        if req.zone == "local" and cl and cl not in ("românia", "romania", ""):
            flags.append({"type": "zone_mismatch", "message": f"Zone local but country '{s.country}'"})

        # Duplicate name
        same = sum(1 for o in req.suppliers if o.name == s.name)
        if same > 1:
            flags.append({"type": "duplicate_name", "message": f"'{s.name}' appears {same} times"})

        if flags:
            issues.append({"supplier_index": idx, "supplier_name": s.name, "flags": flags})

    rejected_indices = list(set(rejected_indices))
    return {
        "flagged": len(issues) > 0,
        "issues": issues,
        "rejected_supplier_indices": rejected_indices,
        "passed_supplier_count": len(req.suppliers) - len(rejected_indices),
        "engine": "local_sourcing_rules",
    }


# ── Stage 2: LLM Semantic Validation ─────────────────────────────────────────

async def llm_check_sourcing(req: ValidateSourcingRequest) -> dict | None:
    """
    Stage 2: Ask an LLM to verify supplier plausibility.
    Returns additional flags not catchable by regex.
    """
    if not llm_available:
        return None

    supplier_list = "\n".join(
        f"{i+1}. {s.name} (website: {s.website or 'none'}, country: {s.country or 'unknown'}, email: {s.email or 'none'}, phone: {s.phone or 'none'})"
        for i, s in enumerate(req.suppliers)
    )

    prompt = f"""You are a B2B procurement data quality auditor. Analyze these AI-suggested suppliers and flag any that look suspicious.

PRODUCT BEING SOURCED: {req.productDescription or 'unknown'}
ZONE: {req.zone} ({req.zoneLocation or 'unspecified'})
BUDGET: {req.budgetMin or '?'} - {req.budgetMax or '?'} {req.currency}

SUPPLIERS:
{supplier_list}

For each supplier, check:
1. Does the company name sound like a real business? (not generic/fabricated)
2. Is the website domain plausible for this company?
3. Does the country make sense for the product and zone?
4. Are there obvious duplicates (same company, different spelling)?

Return ONLY JSON, no markdown:
{{"flags": [{{"index": 0, "type": "likely_fabricated", "message": "reason"}}, ...]}}

If all suppliers look reasonable, return: {{"flags": []}}"""

    try:
        import httpx

        if ANTHROPIC_API_KEY:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
                    json={"model": "claude-haiku-4-5-20251001", "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}]},
                )
                if resp.status_code == 200:
                    text = resp.json()["content"][0]["text"]
                    return json.loads(re.search(r'\{[\s\S]*\}', text).group())

        elif OPENAI_API_KEY:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
                    json={"model": "gpt-4o-mini", "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}]},
                )
                if resp.status_code == 200:
                    text = resp.json()["choices"][0]["message"]["content"]
                    return json.loads(re.search(r'\{[\s\S]*\}', text).group())

    except Exception as e:
        print(f"[NeMo] LLM check failed: {e}")

    return None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"ok": True, "llm_available": llm_available}


@app.get("/status")
def status():
    return {
        "service": "nemo-guardrails-sourcing",
        "version": "2.0.0",
        "llm_available": llm_available,
        "llm_provider": "anthropic" if ANTHROPIC_API_KEY else "openai" if OPENAI_API_KEY else "none",
        "port": NEMO_PORT,
    }


@app.post("/validate/quick")
def validate_quick(req: ValidateSourcingRequest):
    """Stage 1 only — fast local rules, no LLM."""
    return local_check_sourcing(req)


@app.post("/validate/sourcing")
async def validate_sourcing(req: ValidateSourcingRequest):
    """Full validation: Stage 1 (local) + Stage 2 (LLM semantic)."""
    # Stage 1: Local rules
    result = local_check_sourcing(req)

    # Stage 2: LLM semantic check (if available)
    llm_result = await llm_check_sourcing(req)
    if llm_result and llm_result.get("flags"):
        for flag in llm_result["flags"]:
            idx = flag.get("index", -1)
            if 0 <= idx < len(req.suppliers):
                # Find or create issue entry for this supplier
                existing = next((i for i in result["issues"] if i["supplier_index"] == idx), None)
                if existing:
                    existing["flags"].append({"type": flag.get("type", "llm_flag"), "message": flag.get("message", "LLM flagged")})
                else:
                    result["issues"].append({
                        "supplier_index": idx,
                        "supplier_name": req.suppliers[idx].name,
                        "flags": [{"type": flag.get("type", "llm_flag"), "message": flag.get("message", "LLM flagged")}],
                    })
                result["flagged"] = True
        result["engine"] = "local_sourcing_rules+llm"

    return result


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    print(f"[NeMo Sourcing] Starting on port {NEMO_PORT} (LLM: {'yes' if llm_available else 'no'})")
    uvicorn.run(app, host="0.0.0.0", port=NEMO_PORT)
