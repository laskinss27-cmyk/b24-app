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
| `/api/deal/*` | deal items, phases, variants, proposals in Word/Excel/PDF, sales receipt, requests, and sales |
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

Deal print forms share the data returned by `POST /api/deal/kp`. The read-only `POST /api/deal/kp-docx` route creates the Word file, while `POST /api/deal/export-xlsx` creates Excel. The proposal PDF and sales receipt use the frontend and the browser's system print dialog. Contract context and Word generation are served by `/api/contracts/context` and `/api/contracts/generate`. For generation, the frontend supplies the template, our legal entity, customer type, date, address, and work duration; the backend derives the contract number and VAT automatically.

Linked deal and supply-request lines are changed only through server routes. `POST /api/deal/replace-plan-product` replaces an unallocated product in both the working deal composition and its open supply request. `POST /api/supply/request-line` lets supply staff change the product or quantity and applies the same change to the deal. Quantity cannot fall below the allocated amount, and a fully allocated line is locked.

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
