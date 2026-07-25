# b24-app documentation

**English** · [Русский](../README.md)

This documentation describes the production system running on the corporate VPS. Transitional environments and temporary routes are intentionally excluded from the operational instructions.

## Where to start

| Document | Audience and purpose |
|---|---|
| [user-guide.md](user-guide.md) | employees: deals, procurement, warehouse operations, repairs, and contracts |
| [overview-simple.md](overview-simple.md) | short, non-technical system overview |
| [vision-flow.html](vision-flow.html) | visual boundary between Bitrix24 and the inventory core |
| [architecture.md](architecture.md) | developers: components, data ownership, and authentication |
| [features.md](features.md) | current user-facing modules |
| [api.md](api.md) | backend HTTP route groups |
| [network.md](network.md) | production network architecture and ports |
| [runbook.md](runbook.md) | Bitrix24 integration, deployment, rollback, and recovery |
| [SOS.md](SOS.md) | diagnostics and incident response |
| [failure-map.md](failure-map.md) | feature dependencies on Bitrix24, the backend, and ERPNext |
| [scripts.md](scripts.md) | safe use of operational scripts |
| [sklad-vynos.md](sklad-vynos.md) | inventory-core boundaries and data-handling rules |
| [b24-rest-grabli.md](b24-rest-grabli.md) | verified Bitrix24 REST API behaviour and pitfalls |

## Decision records and history

These files preserve the reasoning behind individual decisions. They do not replace the runbook:

- [native-deal-status.md](native-deal-status.md);
- [montage-service-sum.md](montage-service-sum.md);
- [sozvony-razbor-2026-06.md](sozvony-razbor-2026-06.md).

## Key facts

- The production address is managed outside the repository.
- Backend: container `b24-backend`, host-local port `127.0.0.1:3000`.
- ERPNext: private Docker Compose stack, host-local port `127.0.0.1:8080`.
- Code, configuration, and secrets use environment-specific production paths; secrets are not stored in Git.
- ERPNext is the source of truth for warehouse stock and documents.
- Bitrix24 is the source of truth for CRM entities.
- The inventory-core backup follows a private production schedule.

## Documentation currency

If a change affects a screen, route, placement, environment variable, data source, or deployment procedure, the relevant document must be updated in the same commit. Unconfirmed plans must be labelled as plans and never described as delivered functionality.
