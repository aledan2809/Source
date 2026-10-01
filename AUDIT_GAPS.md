# AUDIT_GAPS — source
Last Updated: 2026-10-01

## Eliminated Gaps

| ID | Severitate | Descriere | Status | Commit | Data |
|----|-----------|-----------|--------|--------|------|
| G-SRC-001 | P1 | Lipsă rate limiting pe /api/ai (AI calls costisitoare) | Eliminated | 4740a38 | 2026-05-18 |
| G-SRC-002 | P1 | Lipsă rate limiting pe /api/search-product-url (external API calls) | Eliminated | 4740a38 | 2026-05-18 |
| G-SRC-003 | P2 | Lipsă rate limiting pe /api/source/feedback (write operation) | Eliminated | 4740a38 | 2026-05-18 |
| G-SRC-004 | P2 | Lipsă rate limiting pe /api/source/supplier-feedback (write operation) | Eliminated | 4740a38 | 2026-05-18 |

## Open Gaps

| ID | Severitate | Descriere | Status | Note |
|----|-----------|-----------|--------|------|
| G-SRC-005 | P3 | console.error() în producție | OPEN | Monitorizare normală, risc scăzut |
| G-SRC-006 | P0 | `/api/rfq/send` trimitea prin contul Resend comun (techbiz.ae, 7 aplicații) — prospectare la rece, interzisă de Resend; pe VPS2 aplicația e publică (fără `ACCESS_TOKEN`, port 3030 deschis în UFW), deci era un releu deschis cu expeditor techbiz.ae | FIXED IN CODE — NEDEPLOYAT | `6c1f03a`: trimiterea doar prin căsuță proprie (`OUTREACH_SMTP_*`), altfel 503 + mesaj; refuză și în producție fără `ACCESS_TOKEN`. Închis abia după deploy. |
| G-SRC-007 | P1 | Aplicația e publică pe VPS2: fără `ACCESS_TOKEN`, port 3030 `ALLOW Anywhere`; limita de rată se poate ocoli (antetul `x-forwarded-for` vine de la client când nu există nginx în față) | OPEN | Acțiune user: setează `ACCESS_TOKEN` și/sau închide 3030 în UFW. Atinge și rutele AI (cost). |

Journey audit: 1/1 OK (/)
ML2 Wave 5 Verdict: PASS
