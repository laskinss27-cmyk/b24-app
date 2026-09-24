# Project operating rules

## Production deployment

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
