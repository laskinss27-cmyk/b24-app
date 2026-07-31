# Project operating rules

## Production deployment

- Always run `b24-backend` with `--network erpnext_frappe_network`. The backend resolves ERPNext through the Docker hostname `frontend`; without this network, deal plans and other core-backed data appear empty even though the data is intact.
- Preserve the currently running backend container as the rollback container before switching versions.
- After every deployment, verify all three checks: `GET /health` internally, `GET /health` through the public entry point, and a read-only request from `b24-backend` to ERPNext. The two HTTP health checks alone do not prove that the backend can reach the core.
- Do not consider a deployment complete until `docker inspect b24-backend` confirms membership in `erpnext_frappe_network`.
