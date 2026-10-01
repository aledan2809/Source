
## 🔍 Introspection Audit 2026-06-20
> Audit complet (gap strategie↔cod · ghid per-pagină · deep research · funcțional + cyber).
> 4 acțiuni deschise · 🔴 1 critice (librărie/local — fără scor extern).
> Rapoarte: `Reports/INTROSPECTION-2026-06-20/` (00-SUMMARY.md, 01-gap-strategy-vs-code.md, 02-pages-guide-RO.md, 03-deep-research-optimization.md, 04b-security-audit.md)
> Checklist Alex centralizat: `Master/reports/Alex_TODO_2026-06-20.md` + tab „Introspection Audit" în UI Master.

## source (local VPS2:3030, fără domeniu) — ACTIVE (fix-urile așteaptă review)
Sursă: `source/Reports/INTROSPECTION-2026-06-20/`

- [ ] 🔴 **Configurează `SERPER_API_KEY`** (gratuit 2500/lună) — căutarea web (feature-ul CENTRAL de descoperire furnizori) rulează degradat fără ea.
  - 🗣️ *Pe înțelesul tău:* Fără cheia gratuită de căutare, funcția principală — găsirea de furnizori pe web — merge prost. După setare (gratis), descoperirea furnizorilor funcționează la capacitate.
- [~] 🔴 **E-mailurile către furnizori — doar prin căsuță proprie** (strategia e-mail, Pasul 0, 2026-10-01, commit `6c1f03a`, **nedeployat**).
  Codul nu mai trimite prin contul Resend comun; până există o căsuță proprie, trimiterea e oprită și omul vede „poți copia mesajul". Expeditorul era deja impus de server (nu se mai poate alege din exterior).
  - [ ] Deploy pe VPS2 (`/var/www/source`, rebuild + restart) — până atunci aplicația publică încă poate trimite prin Resend.
  - [ ] Decide căsuța proprie pentru cererile de ofertă (de preferat **nu** pe techbiz.ae — prospectarea strică reputația întregului domeniu) și setează `OUTREACH_SMTP_HOST/PORT/USER/PASS/FROM` în `/var/www/source/.env.local`.
  - [ ] Scoate `SMTP_HOST/PORT/USER/PASS` + `EMAIL_FROM` din `.env.local` pe VPS2 — țin cheia Resend comună și nu mai sunt citite.
  - 🗣️ *Pe înțelesul tău:* Cererile de ofertă către furnizori nu mai pleacă prin serviciul de e-mail comun al tuturor aplicațiilor (care risca suspendarea). Până îi dăm Source o căsuță a ei, butonul „Trimite" e oprit și poți copia mesajul ca să-l trimiți tu.
- [ ] 🔴 **App publică pe VPS2** (fără `ACCESS_TOKEN`) — **verificat 2026-10-01: portul 3030 E expus** (UFW `ALLOW Anywhere`). Setează `ACCESS_TOKEN` (fără el, codul nou refuză oricum trimiterea către furnizori) și/sau închide 3030 în UFW. Vezi `AUDIT_GAPS.md` G-SRC-007.
  - 🗣️ *Pe înțelesul tău:* Aplicația n-are parolă, deci oricine ajunge la ea o poate folosi. După setarea unui token de acces, doar tu intri dacă cumva ajunge expusă online.
- [ ] 🟡 **`npm audit fix`** (7 vulns, 1 critic/4 high, protobufjs+ws tranzitive) + doc-lift (STRATEGY/CONTEXT lipsă).
  - 🗣️ *Pe înțelesul tău:* Sunt 7 vulnerabilități în biblioteci și lipsește documentația de bază. După fix, e sigur și ai descrierea proiectului.
- _Solid: chei server-side, 0 `.env` în git, upload/path-traversal apărate, rate-limit pe endpoint-urile scumpe._

---
