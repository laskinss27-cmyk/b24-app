# Technical overview

[Русская версия](../overview-tech.md)

## Stack

- Node.js 20, TypeScript, Fastify 5;
- React 18, Vite 6;
- npm workspaces;
- ERPNext 16 / Frappe;
- MariaDB, Redis, and workers in Docker Compose;
- nginx and Let's Encrypt.

## Runtime

The frontend and backend are built into one `b24-app:<commit>` Docker image. Fastify serves the frontend and handles placements and the API. The container joins `erpnext_frappe_network` and accesses ERPNext at `http://frontend:8080`.

On the host:

- backend — `127.0.0.1:3000`;
- ERPNext — `127.0.0.1:8080`;
- nginx — public ports `80/443`.

## Bitrix24 integration

- server-side local application;
- placements for the deal tab, left menu, report, and task;
- current-user token for regular API requests;
- OAuth cookie for mobile mode;
- entity storage for internal state;
- Bitrix24 Drive for documents and an external database-dump copy.

## ERPNext integration

The backend uses the REST API with a dedicated token. Stock postings are performed through standard ERPNext documents and verified after submission. The ERPNext user interface is not exposed to users.

## Operations

- deployments use an immutable tag based on the short Git commit hash;
- the previous container is retained;
- internal and public health checks are mandatory;
- daily database dump and weekly file archives;
- migration scripts are not part of the runtime and are not scheduled.

Architecture and procedures: [architecture.md](architecture.md), [network.md](network.md), [runbook.md](runbook.md).
