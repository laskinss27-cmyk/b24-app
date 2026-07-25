# ERPNext inventory core

[Русская версия](../sklad-vynos.md)

This document defines the current inventory-system boundary. Migration history is no longer an operational instruction.

## Current state

ERPNext v16 runs as a headless inventory core on the corporate VPS. Employees do not need its standard interface: operations are performed in our Bitrix24 screens, and the backend calls the ERPNext REST API.

ERPNext stores:

- products and services used by the inventory workflow;
- warehouses;
- prices;
- actual stock levels;
- receipts, write-offs, sales, and returns;
- transfers and stocktake adjustments.

Bitrix24 continues to store CRM data: deals, customers, owners, tasks, files, and business processes.

## Invariants

1. Stock changes only through a submitted ERPNext document.
2. A draft does not affect stock.
3. The UI never calculates a separate “true stock” value.
4. A sale or return retains its source-document and deal relation.
5. A network timeout is not proof that a document was not created.
6. Bulk migrations do not run alongside daytime sales.
7. Current stock is fetched again before catalogue or duplicate correction.

## Catalogue and product card

The primary catalogue row and inventory fields come from ERPNext. A product card may be enriched with legacy Bitrix24 catalogue data: image, description, manufacturer, model, and section.

The technical reference string containing the source product ID is not a product description and is not shown to users.

Product creation or editing must preserve a stable link between ERPNext and Bitrix24. Bulk renaming must not run without a before-and-after mapping report.

## Duplicates and normalisation

Planned safe procedure:

1. fetch fresh products and stock from ERPNext overnight;
2. build a read-only duplicate report;
3. agree on canonical name, manufacturer, and model;
4. verify references from deals and documents;
5. apply a small batch;
6. verify cards, search, stock, and new documents;
7. only then continue.

Merging inventory items with non-zero stock requires explicit adjustment documents, not simple duplicate deletion.

## Per-unit product statuses

The future model must separate the condition of a specific unit from the product name. Terms such as `stock`, `display item`, `scratched`, or `clearance` must not be permanently embedded into the SKU name.

Possible future states:

- standard;
- clearance;
- display item;
- damaged;
- held for diagnostics.

This model is not implemented yet. Until the core is extended, these terms cannot be removed in bulk because the system has nowhere else to preserve their quantity- or batch-level meaning.

## Backups

Data lives in ERPNext Docker volumes and is backed up daily by a server-side script whose production path and schedule are held in private configuration. Database dumps have local retention and an external copy on Bitrix24 Drive. Recovery details are in [runbook.md](runbook.md).
