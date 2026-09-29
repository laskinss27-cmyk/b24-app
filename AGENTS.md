# Project operating rules

## Independent judgment and working with the user

- Exercise independent technical judgment; do not silently comply or agree with a request that would clearly harm production, degrade the product, lose data, or break existing functionality. The user is not a programmer and must not be expected to foresee technical consequences.
- Before taking such an action, stop, explain the concrete consequences in plain language, and propose safer alternatives when available. If the risk is uncertain, investigate before making the risky change. Resolve the concern with the user before proceeding with the harmful action; a direct instruction alone does not remove this responsibility.
- Carry agreed work through autonomously, but never interpret autonomy as blind execution. Raise evidence-backed objections without inventing risks or adding unnecessary approval steps to routine safe work.

## Feature continuity and documentation

- Use `docs/feature-registry.md` as the versioned map of business rules, implementation paths, regression tests, and known gaps. Update the affected rule in the same commit as behavior changes. Keep retired rules with the reason, replacement, and migration decision; do not silently delete them.
- Before a release, review changed/removed rules and tests against the registry and the currently deployed SHA. File presence and release provenance do not prove business behavior. Resolve the open regressions recorded in `docs/audits/2026-09-29-feature-audit.md` before treating a green test run as release readiness; diagnostics are not approved release exceptions.
- Backend/frontend test commands must discover all `src/**/*.test.ts` and `src/**/*.test.tsx`; do not replace discovery with a hand-maintained subset. New or recovered regression tests belong in the normal suite. Review unexplained decreases in test coverage/counts.
- Store specifications and recovery references in tracked docs. Ignored `outputs`, temporary worktrees, and deployment logs may supplement evidence but must not be the only description of a shipped feature. When architecture changes, record the old/new data source and compatibility implications.

## Production deployment

- Use `node scripts/b24-release.mjs build` from a clean, pushed Git checkout and `bash scripts/b24-deploy.sh IMAGE FULL_SHA` for production updates. The deploy script must pass the pre-deploy guard before stopping the service; do not replace it with ad hoc stop/run commands. See `docs/release-provenance.md` for archive transfer and the one-time legacy migration.
- The complete commit SHA must agree between Git, OCI image labels, baked-in `release.json`, and both `/health` responses. Create a stopped candidate, verify its immutable image ID against the guard before stopping production, then start that exact container ID. Never set the release SHA through the inherited runtime environment.
- A dirty/unpushed checkout, non-descendant release, failed test suite, image hash mismatch, or uncommitted production hotfix blocks deployment. Reconcile the changes in Git and rebuild; do not bypass the guard. Record intentional recovery/rollback separately.

- Build application releases from a committed Git revision in a clean checkout. Never base a release image on the currently running application image or copy only selected source files into it: that hides missing Git files and can drop features at the next full rebuild.
- Before switching containers, run the backend and frontend test suites, including the deal control regression tests, and run `scripts/b24-release-source-guard.sh` against the candidate image. Reconcile any production source files absent from the candidate before deploying.
- Always run `b24-backend` with `--network erpnext_frappe_network`. The backend resolves ERPNext through the Docker hostname `frontend`; without this network, deal plans and other core-backed data appear empty even though the data is intact.
- Preserve the currently running backend container as the rollback container before switching versions.
- Treat every filesystem path in `docs/runbook.md` as a placeholder unless private production configuration confirms it. When updating an existing `b24-backend`, derive its effective environment, `/app/state` source, and public URL from the running container as documented; never assume an env-file path.
- After every deployment, verify all three checks: `GET /health` internally, `GET /health` through the public entry point, and a read-only request from `b24-backend` to ERPNext. The two HTTP health checks alone do not prove that the backend can reach the core.
- Do not consider a deployment complete until `docker inspect b24-backend` confirms membership in `erpnext_frappe_network`.

## Docker retention

- Keep the running services, images used by scheduled catalog/Tilda jobs, and only the two latest distinct successful b24-app rollback versions. The production retention timer enforces this policy hourly after a one-hour deployment safety window.
- After a successful deployment and its required checks, run the installed `b24-docker-retention.service`; a recent deployment may defer cleanup to the next timer run. See `docs/docker-retention.md` and `scripts/b24-docker-retention.py`.
- Never use broad image/system/volume pruning: scheduled jobs may use images without a persistent container. Never remove volumes, bind-mounted state, databases, or backups during Docker cleanup.
