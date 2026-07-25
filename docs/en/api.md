# Backend HTTP routes

[Русская версия](../api.md)

Example public base URL: `https://app.example.com`. The production value is managed outside the repository. Most `/api/*` routes are called only by the frontend embedded in Bitrix24 and receive the current-user context.

## Service and OAuth routes

| Method and path | Purpose |
|---|---|
| `GET /health` | backend process status |
| `GET|POST /app/handler` | main local-application entry point |
| `POST /install` | installation and initial placement binding |
| `POST /uninstall` | application-removal notification |
| `GET /m` | mobile stocktaking entry point |
| `GET /m/callback` | mobile OAuth callback |

## Placements

All placement routes accept a Bitrix24 POST and return the same built frontend with the required context:

- `/placement/deal-tab`;
- `/placement/task-inventory`;
- `/placement/inventory`;
- `/placement/catalog`;
- `/placement/sales-report`;
- `/placement/repairs`;
- `/placement/stock`;
- `/placement/supply`.

## API areas

| Prefix | Area |
|---|---|
| `/api/deal/*` | deal items, phases, variants, proposals, Excel, requests, and sales |
| `/api/contracts/*` | contract context and generation |
| `/api/catalog/*` | catalogue, product cards, prices, stock, and comparison |
| `/api/inventory/*` | stocktakes and adjustment documents |
| `/api/stock/*` | inventory documents and product movement |
| `/api/transfer-requests/*` | transfer requests and orders |
| `/api/transfers/*` | transfer lifecycle |
| `/api/supply/*` | requests, suppliers, purchasing, and receipt |
| `/api/marketplaces/*` | marketplace sales, bundles, and returns |
| `/api/repairs/*` | repairs, statuses, prices, files, and search |
| `/api/realizations/*` | sales journal |
| `/api/reports/*` | reports |
| `/api/quicksale/*` | quick sale |

The authoritative list of individual endpoints is the `app.get` and `app.post` registration in `packages/backend/src/routes/`. This document must be updated whenever a route group is added or removed.

## Request authentication

The frontend supplies:

- portal domain;
- access token of the current user;
- context identifiers such as deal, document, warehouse, or repair.

The backend:

1. accepts only the configured `PORTAL_DOMAIN`;
2. calls Bitrix24 on behalf of the current user;
3. never exposes the ERPNext token to the client;
4. checks roles for sensitive actions;
5. returns JSON errors with a clear message.

Direct Bitrix24 calls from React should be avoided because they complicate permissions, timeouts, and auditing.

## Change rules

- Read-only routes must not create documents.
- A write route must state what it created or changed.
- After a network error, retry only after confirming that the document was not already created.
- Secrets and complete request bodies containing OAuth tokens must not be logged.
