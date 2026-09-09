# Deal realization purchase-price guard — 2026-09-09

Requested: prevent deal goods from being realized without a purchase price; users should ask supply staff to fill it.

- New realization drafts validate all parsed groups before creating Delivery Notes.
- Posting validates fresh prices for all requested stored Delivery Notes before submitting the first document. Old drafts do not bypass this check. Stored deal ownership and draft status are checked; request-body prices/service flags are not trusted.
- Same price precedence as the catalog/deal display: ERP Standard Buying, then Bitrix purchasing price only if no ERP price record exists. Canonical aliases are respected. No display cache or stock valuation fallback is used.
- Missing, zero, negative and non-finite purchase prices block commercial goods. The error lists product names/IDs and directs the user to supply to enter a price greater than zero. It does not reveal purchase amounts.
- ERP services and trusted server-classified draft services are exempt. Pass-through consumables retain cost equal to the line's sale price. Return drafts are exempt; the existing return operation remains unchanged. Marketplace sales and historical realization amendments are outside this change.
- Existing error rendering is used; no frontend rebuild required.

Validation: 77 tests passed, including full-batch rejection before any submit, old drafts, retry after price correction, ERP-zero precedence, aliases, services, consumables, returns, fake client overrides, ownership, prior receipt/last-line guards and ERP regressions. Backend TypeScript build passed. Isolated image HTTP canary passed with no production data mounted.

Image `b24-app:deal-price-guard-20260909` layers only two changed backend modules onto the current image. Rollback container preserved: `b24-backend-prev-before-deal-price-guard-20260909`. Internal/public health, official ERP Company read and docker-inspected `erpnext_frappe_network` membership verified.

Audit bundle, deployment log and read-only real-catalog check: `D:/Projects/b24-app/outputs/deal-price-guard/`. No real realization was posted for testing and no historical cost/stock data was rewritten.
