# Last supply-request line — 2026-09-09

Requested: allow removal of the last line and remove the now-empty supply request.

- `removeSupplyRequestLineRemainder` deletes only the exact draft Material Request when its last line is entirely unallocated. It returns `requestDeleted: true`; it never writes an empty items array or changes the deal plan.
- Partially allocated lines retain their allocated quantity. Fully allocated lines remain protected.
- Whole-request deletion requires `supply.delete_documents`; line editing permissions alone are insufficient. Supply profile already includes that permission.
- Exact request creation key, product ID and optional row ID are checked. Submitted/cancelled requests cannot be automatically deleted.
- Active linked transfers and ERP purchase orders, receipts and stock entries prevent deletion even if calculated allocation is zero. No child document is cascade-deleted. Read/deletion failures propagate to the user.
- Line changes use the existing per-request supply creation lock, released on success/error. API returns and logs `requestDeleted`.
- Frontend confirmation explains last-line deletion and that deal goods stay unchanged. Existing refresh clears pending decisions and reloads the request list after success.

Verification: 82 tests passed, including isolated HTTP deletion, denial, shared lock, stale identity, linked documents, partial/full allocation, ERP failures, existing ERP operations, receipt price guard and frontend API/layout. Backend/frontend TypeScript checks and Vite production build passed.

Deployment layers two backend modules and the rebuilt frontend onto the exact running receipt-guard image. Image: `b24-app:supply-last-line-20260909`. Preserved rollback container: `b24-backend-prev-before-supply-last-line-20260909`.

Verified internal/public health, official ERP read, linked-document API fields, `erpnext_frappe_network` membership and isolated image HTTP canary. No real request was deleted for testing. Audit bundle, canary and deployment log: `D:/Projects/b24-app/outputs/supply-last-line/`.
