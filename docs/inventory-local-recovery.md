# Local inventory draft export

`/inventory-draft-recovery.html` is a standalone, read-only recovery page for
inventory 21648, store -1865999992 (Максидом Богатырский 15).

Open it in a new tab in the same browser, profile and origin used for counting.
Do not refresh the original inventory screen: it runs the normal autosave flow.
The recovery page does not import the application, initialize Bitrix authentication,
call inventory endpoints, modify localStorage or restore any production records.
Its CSP blocks network API connections. Only two exact count/act keys are read.

Version 2 paints the static page first and reads storage only after the explicit
"Найти черновик" button, with a short paint delay and a visible error fallback.
File-sharing capability checks happen only after the explicit share button.
The first read is frozen in memory and exported as a JSON file. Each entry retains
the original storage string, including pending:false, unknown fields and damaged
JSON. Displayed counts are advisory; the raw string is the recovery evidence.
Only an explicit user action invokes the browser share sheet or downloads a file.
Manual text selection remains available if file APIs fail.

An empty result is not proof of data loss: another origin, profile, private session,
or an unpersisted in-memory draft may hold the data. This page cannot recover data
already overwritten or removed by Safari. Do not apply exports automatically;
validate their inventory/store identity and quantities before any separately
authorized restoration.

Checks: `node --test scripts/inventory-draft-recovery.test.mjs`, frontend tests,
workspace typecheck/build, and isolated browser smoke with synthetic data at
390px and 1280px (download content, unchanged storage, no API calls, no overflow).
Real iPhone Safari testing remains an operator step.
