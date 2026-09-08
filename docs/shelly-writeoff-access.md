# Scoped Shelly write-off access

User explicitly approved implementation and deployment on 2026-09-08.
Portal profiles visually verified: Савченко Николай (760), Маркетплейсович Николай (3608).

Both identities gain creation and posting of Material Issue documents for Shelly only.
The server validates the source store on creation and reads the actual ERP document before posting:
type/purpose Material Issue, draft, every source warehouse exactly Shelly in the current ERP company,
no destination warehouse and no mixed-warehouse lines. Client-provided warehouse on posting is not trusted.

General stock management, supply, receipts, transfers, cancellation, price editing and product creation
are not expanded. Existing administrator/supply rights remain unchanged. No department changes,
policy activation, SQL migrations, state rewrites or test stock movements are required.

UI: Складской учёт → Списания → Создать списание. Restricted accounts see only Shelly in the source selector;
creation produces a draft, and posting remains a separate deliberate action.
Legacy canCreate/canCancel flags are unchanged because other workflows consume them.

Verification: npm run typecheck, complete backend/frontend suites, and both workspaces' test:shelly-access.
Scoped routes tested with isolated mocked clients, including two valid identities, unrelated user,
other warehouse, mixed lines, disguised transfer/receipt, denied cancellation/product creation,
and preserved administrator access. Restricted form also inspected in a local browser fixture.

Deployment must preserve the existing b24-backend as rollback, retain its effective env/state/ports,
and verify internal/public health, readiness, ERP REST read, frontend bundle identity and
erpnext_frappe_network membership. Operation scripts/results: outputs/shelly-access in the main workspace.
