# DC Solar KC — Our First 100 Days (report)

Regenerate with up-to-date numbers (Windows, from the repo root):

1. `node scripts/reports/first-100-days/collect.mjs` → `data.json` next to the script (gitignored — company financials).
   Reads the live database + QuickBooks (via `scripts/qbo/qbo.mjs`), the Chase activity CSV in Downloads, and `scripts/qbo/out/plan.json`.
2. Put `logo.png` next to the script (decode `LOGO_DATA_URI` from `app/src/assets/images/logo-base64.ts`).
3. `node scripts/reports/first-100-days/build.mjs` → `report.html`.
4. Print to PDF with Chrome:
   `chrome --headless=new --no-pdf-header-footer --virtual-time-budget=15000 --print-to-pdf="data/reports/DC Solar KC - Our First 100 Days.pdf" file:///…/report.html`

Day 1 = 2026-07-01. Charts are hand-drawn SVG (no chart library). Palette: dark green / tan / cream.
