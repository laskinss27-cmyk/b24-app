# Deployment

**English** · [Русский](README.md)

This directory contains sanitised, reviewable examples of the VPS configuration. Production addresses, paths, and secrets are supplied outside the repository.

| File | Production location | Purpose |
|---|---|---|
| `pwd.yml` | `/srv/erpnext/pwd.yml` | ERPNext, MariaDB, Redis, and worker stack |
| `nginx-b24.conf` | `/etc/nginx/sites-available/b24-app` | HTTPS entry point and backend proxy |
| `backend.env.example` | template for a private environment file | application environment variables |
| `sync.env.example` | template for a private environment file | service-script access to ERPNext and Bitrix24 |

The backend is built from the root [Dockerfile](../Dockerfile) and joins the `erpnext_frappe_network` Docker network. The production container listens on port `8080` internally and is published only on `127.0.0.1:3000`.

Complete procedures:

- initial installation and Bitrix24 integration — [docs/en/runbook.md](../docs/en/runbook.md);
- network architecture — [docs/en/network.md](../docs/en/network.md);
- incident response — [docs/en/SOS.md](../docs/en/SOS.md).

Real `.env` files, keys, tokens, database dumps, and certificates must never be committed.
