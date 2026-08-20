# Failure map

[Русская версия](../failure-map.md)

## Dependencies

| Component | What stops working | What continues working | First action |
|---|---|---|---|
| Bitrix24 | user sign-in, CRM context, and REST calls | backend and ERPNext may remain technically healthy | check portal status and do not repeat writes blindly |
| nginx or TLS | all custom screens are externally unavailable | backend and ERPNext remain locally accessible on the VPS | compare external and internal health |
| `b24-backend` | our screens and API | standard Bitrix24 sections and ERPNext data | inspect container logs, restart, or roll back |
| ERPNext frontend/backend | catalogue, stock, and warehouse operations | Bitrix24 CRM and some unrelated screens | check `ping`, Compose status, and ERPNext logs |
| ERPNext MariaDB | the entire inventory system | Bitrix24 | do not recreate volumes; prepare recovery |
| separate `b24_app` database | future application workflow after a source switch; nothing while mode is `off` | current ERPNext and Bitrix fallbacks | inspect `/ready`; do not switch sources or retry writes blindly |
| OAuth/user permissions | selected actions are denied | actions covered by existing permissions | check user and application scopes |
| Bitrix24 Drive | document uploads and external backup copy | inventory postings and local backup | inspect REST error and local file |

## Signals

- `GET /health` confirms only the backend process, not ERPNext or Bitrix24 availability.
- `GET /ready` reports `b24_app` separately; `disabled` is expected until an explicit rollout.
- `GET http://127.0.0.1:8080/api/method/ping` confirms ERPNext HTTP availability, not the validity of a specific posting.
- A successful write-route response should contain the ID of the created document.
- A timeout after sending a request requires checking for the document by ID, timestamp, and source.

## Recoverability

- Code and configuration templates — Git.
- Secrets — separate server-side environment files.
- ERPNext data — Docker volumes and backups.
- CRM data — Bitrix24.
- Previous backend image and container — retained during deployment.

## Prohibited incident actions

- deleting Docker volumes;
- rerunning catalogue migration over the production core;
- bulk duplicate deletion without a report;
- database recovery without recording the selected dump;
- repeated clicks on a write action after a timeout.

Step-by-step commands are in [SOS.md](SOS.md).
