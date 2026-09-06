# Inventory draft save acknowledgement hotfix

The server no longer returns `ok:true, ignored:true` for draft saves to a submitted
or reconciled point. It returns `ok:false` with a readable reason and a diagnostic
code. Existing phone clients already reject `ok:false`, so active counting does
not require an immediate reload. A reopened point accepts the existing payload.

The same-session sequence guard acknowledges a duplicate only if its sequence,
facts and supplied sanitized comments match the persisted draft exactly. Older
or conflicting retries fail without overwriting the current draft. This guard
does not solve stale writes between different sessions; a versioned concurrency
protocol and retained draft history remain separate work.

New frontend code also rejects the old `ignored:true` response, retains its pending
local copy, and displays the server's save error. Mobile entry does not open an
editable count form for an already submitted/reconciled point or closed inventory.
The existing local-storage best-effort behavior is unchanged; this is not a
guarantee against device/browser storage loss.

No migrations, SQL mode changes, manual fact edits or inventory status transitions
are part of this deployment. Preserve the previous backend container and its exact
environment/state/network. Keep a read-only server snapshot of inventory 21648
before switching; do not run write probes against the employee's live inventory.

Regression coverage lives in `routes/api-inventory.test.ts`, `inventory-api.test.ts`
and `inventory-draft.test.ts`: locked saves return a real error; reopened legacy
clients continue to save; identical retries succeed; stale/conflicting retries
cannot overwrite facts; old ignored responses cannot be treated as success.
