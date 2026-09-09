# Catalog / deal purchase-price consistency — 2026-09-09

## Cause and scope

The catalog used Standard Buying with a legacy Bitrix purchasing-price fallback.
The deal stock endpoint used Standard Buying only. Products such as HDD 2 TB
(15882) therefore showed 5,200 RUB in the catalog and no purchase price in deals.

Both paths now share explicit ERP-price-first precedence. When the ERP price
record is absent, the deal uses the same valid catalog metadata cache or a
targeted, authenticated Bitrix lookup. Variant prices inherit their parent's
price only when the variant's own price is absent. Explicit zero remains zero.
There is no stock-valuation fallback and no price or accounting-document write.
Purchase-price denial is retained and prevents even the fallback price lookup.

## Verification

- TypeScript backend build passed.
- Ten new tests passed, including HTTP stock-route, aliases, denied access,
  explicit zero, variants, cache misses, and Bitrix's empty-code missing-product
  response for the ERP-only engineer-visit service.
- Existing ERP operations (51), catalog/stock route (3), stock access (2) tests passed.
- Live candidate checks ran before switching; a missing-service response was
  caught during the first check, corrected and covered by a regression test.
- Post-deployment actual HTTP endpoint returned: 15882=5200, 16114=15000,
  16836=2800, 18512=2928, 9814001=0. Item Price rows were identical before/after.

## Deployment

Image: `b24-app:purchase-display-20260909`.
Rollback container: `b24-backend-prev-before-purchase-display-20260909`.
Only three compiled route/helper modules and corresponding source/maps were
layered over the exact running image. Unrelated local work was excluded.
Environment, state mount, public URL and port bindings were derived from the
running container. Internal/public health, official ERP API read and explicit
`erpnext_frappe_network` membership passed. No database migration or backfill.

Audit artifacts: `outputs/purchase-display-fix/` and
`outputs/purchase-display-diagnostic/postcheck.json` in the main workspace.
