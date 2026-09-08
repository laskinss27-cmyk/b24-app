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

## Deployed 2026-09-08

Code commit 8d50a7d; image b24-app:8d50a7d-shelly-access-20260908145429551.
Rollback: b24-backend-prev-before-8d50a7d-shelly-access-20260908145429551,
the previous inventory-compatible production container, retained stopped.
Verified internal/public health, readiness, official ERP Company read, runtime scoped-role checks,
public JS /assets/index-DtEUuaTb.js matching the built bytes, and Docker ERP network membership.
All 924 baseline package files matched production (DOCX compared as binary). Local full backend
suite: 444 passed; frontend: 141 passed; targeted scope/API/UI suites: 11 passed, also rerun
in isolated candidate containers with no network or production credentials before switching.

The first attempt safely rolled back because its extra public-index probe requested `/`, which
intentionally does not serve index.html. Corrected the probe to read the asset path from the built
template and verify the actual public JS. The second attempt passed. Both deployment logs and the
first candidate container are retained. No schema, environment-mode or real stock changes were made.
