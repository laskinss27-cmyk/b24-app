# Architecture

[Русская версия](../architecture.md)

## Purpose

`b24-app` is a server-side application and a unified React interface embedded into a corporate Bitrix24 portal. Employees remain inside Bitrix24 while warehouse operations are executed through ERPNext.

## Components

```text
Employee browser
        │ Bitrix24 iframe
        ▼
https://app.example.com
        │
      nginx
        │ 127.0.0.1:3000
        ▼
b24-backend (Fastify + built React app)
        ├── Bitrix24 REST API
        └── http://frontend:8080
                 ▼
             ERPNext
```

Monorepo:

```text
packages/backend   Fastify, OAuth, placements, and /api/*
packages/frontend  React SPA
packages/shared    shared types
```

The frontend is built into `packages/frontend/dist`; the backend serves these files and injects the current placement context.

## Data ownership

| Data | Source of truth |
|---|---|
| deals, contacts, companies, tasks, files | Bitrix24 |
| custom fields and smart processes | Bitrix24 |
| inventory catalogue, prices, warehouses, and stock levels | ERPNext |
| receipts, sales, write-offs, transfers, and returns | ERPNext |
| product names, models, statuses, and structured descriptions | ERPNext |
| images of newly created product cards | ERPNext |
| images and fallback metadata from the legacy catalogue | Bitrix24 when ERPNext has no value |
| internal state for selected processes | Bitrix24 entity storage |

Stock is not regularly mirrored from Bitrix24 into ERPNext. Legacy migration scripts are not part of the production workflow.

The product card edits catalogue metadata only in ERPNext. A description is stored both as
reader-facing text and as protected structured attributes. The UI cannot rename or remove fields
reserved for future filters; users edit their values, and the backend normalizes them again and
rebuilds the displayed description. New free-form attributes are stored as display-only values and
do not become filters until they are explicitly mapped to the schema.

When a product is created, the application first obtains a compatible numeric `productId` from a
technical Bitrix24 catalogue record and then creates the full ERPNext item. Specifications,
description, status, prices, and the new image are stored in ERPNext. The client resizes the image
before upload, and the backend validates it again.

Product metadata and price permissions are checked separately. A user without price permission
sees current prices as read-only, and the backend ignores those fields when saving the card. A new
image for an existing card is uploaded to ERPNext through the same validated path used during
product creation.

## Application entry points

One frontend selects the screen from its context:

- `Products 2.0` deal tab;
- `Products and Services` left-menu item;
- `Inventory Management` left-menu item;
- `Procurement` left-menu item;
- `Repairs` left-menu item;
- sales report;
- `/m` mobile entry point for stocktaking.

The exact handlers are listed in [api.md](api.md).

## Authentication

Standard flow:

1. Bitrix24 opens a placement and supplies the user context.
2. The frontend obtains a short-lived token through the Bitrix24 SDK.
3. The frontend sends the token and portal domain to the backend.
4. The backend validates the domain and calls the REST API on behalf of the current user.

`/m` uses OAuth and a protected cookie. ERPNext server tokens and service webhooks are never sent to the frontend.

## Security

- Only nginx is publicly exposed over HTTPS.
- The backend and ERPNext are bound to loopback or an internal Docker network.
- Tokens are redacted from logs.
- iframe embedding is allowed only for `*.bitrix24.ru`.
- Secrets exist only in server-side environment files.
- Backend write actions validate both the user and the request context.

## Deployment

The VPS runs:

- `b24-backend` — image `b24-app:<git-commit>`;
- Docker Compose project `erpnext`;
- nginx and Certbot;
- daily backup script.

See [runbook.md](runbook.md) for the current deployment and rollback procedure.
