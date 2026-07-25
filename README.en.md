# b24-app

**English** · [Русский](README.md)

An internal application for the `umniydom.bitrix24.ru` portal. It adds custom workspaces to Bitrix24 for deals, the product catalogue, procurement, warehouse operations, stocktaking, repairs, marketplaces, reports, and contracts.

The current documentation starts at [docs/en/README.md](docs/en/README.md). Deployment, Bitrix24 integration, and rollback procedures are described in [docs/en/runbook.md](docs/en/runbook.md).

## Current architecture

- Bitrix24 stores CRM entities: deals, contacts, companies, tasks, files, and custom fields.
- ERPNext acts as the private inventory core: catalogue, prices, warehouses, stock levels, and inventory documents.
- A Node.js backend connects Bitrix24 to ERPNext and serves the frontend.
- The React application is embedded into Bitrix24 through the placement API.
- Production runs on a single corporate VPS at `201.51.12.57`.
- Public entry point: `https://201.51.12.57.sslip.io`.
- ERPNext and the backend are not exposed directly to the Internet; nginx or another container on the same network accesses them.

See [docs/en/architecture.md](docs/en/architecture.md) and [docs/en/network.md](docs/en/network.md) for details.

## Repository structure

```text
packages/
  backend/   Fastify, OAuth, placement routes, and Bitrix24/ERPNext APIs
  frontend/  React SPA embedded into a Bitrix24 iframe
  shared/    shared TypeScript types
deploy/      verified VPS, nginx, and ERPNext configuration
scripts/     operational, diagnostic, and migration tools
docs/        documentation
```

## Development

Node.js 20 or newer is required.

```bash
npm ci
npm run dev:backend
npm run dev:frontend
```

Checks required before committing:

```bash
npm run typecheck
npm -w @b24-app/backend test
npm run build
```

Create local environment variables from [packages/backend/.env.example](packages/backend/.env.example). Secrets, tokens, and working `.env` files must never be committed.

## Change rules

1. ERPNext is the source of truth for warehouse stock. Legacy migration scripts must not be run as a recurring synchronisation job.
2. Scripts and API probes that write data must not be run in production without understanding their full scope.
3. Any change in user-facing behaviour must update the relevant documentation in the same commit.
4. Typecheck, backend tests, and build are mandatory before production deployment.
5. The previous container is retained during deployment for a quick rollback.

## Licence

The code in this repository is proprietary and may not be copied or distributed without the owner's permission.

ERPNext and Frappe are deployed as separate, unmodified services and accessed through their REST APIs. Their source code and licences are published by the respective projects:

- [ERPNext](https://github.com/frappe/erpnext) — GNU GPL v3;
- [Frappe Framework](https://github.com/frappe/frappe) — MIT.
