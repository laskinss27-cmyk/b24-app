# Receipt purchase-price guard — 2026-09-09

Requested: prevent supply staff from posting ordinary goods receipts without a purchase price, with actionable errors.

- `/api/stock/create`: reject absent, zero, negative and non-finite purchase prices before supplier/document/catalog writes. Error identifies product IDs.
- `/api/stock/submit`: read actual Purchase Receipt lines and validate their `rate`, including old drafts. Error identifies names and codes; stock valuation and allow-zero flags do not replace the document purchase price.
- Supply purchase receiving: validate the effective order-line prices before creating or submitting the receipt. Remove automatic 0.01 substitution from purchase-order create/edit and receiving; a missing draft price remains zero until filled.
- Existing positive prices (including an explicitly stored 0.01) are not retrospectively reclassified. Historical documents, catalogue prices and stock balances are not rewritten.
- Repair workflow and Material Receipt inventory-adjustment documents remain unchanged. Existing access checks remain in place.
- The existing frontend already displays the backend error in creation and posting screens; no frontend bundle change is necessary.

Verification: 66 tests passed (ERP operations, stock access, catalog purchasing and new receipt guard tests), backend TypeScript build passed. Isolated image HTTP canary verified invalid and valid requests with no production data mounted.

Production image: `b24-app:receipt-price-guard-20260909`; rollback: `b24-backend-prev-before-receipt-price-guard-20260909`. Deployment derives env/state/public URL from the running container, preserves its exact base image, and layers only four changed backend modules. Internal/public health, official ERP Company read, and `erpnext_frappe_network` membership verified.

Deployment shell printed RELEASE_OK then received a trailing CR from the PowerShell stdin pipeline; an independent inspect confirmed the new container running and rollback stopped. No second deployment was needed.

Audit scripts and runtime verification: `D:/Projects/b24-app/outputs/receipt-price-guard/`.
