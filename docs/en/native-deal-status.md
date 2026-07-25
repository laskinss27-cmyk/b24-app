# Internal deal-fulfilment status

[Русская версия](../native-deal-status.md)

## Delivered behaviour

The Bitrix24 deal has a dedicated text field:

- label: `All items fulfilled`;
- internal code: `UF_CRM_ALL_REALIZED`;
- external code: `B24_APP_ALL_DEAL_ITEMS_REALIZED`;
- values: exactly `ДА` (yes) or `НЕТ` (no).

The field exists for Bitrix24 automation and may be hidden from the manager's regular deal card.

## Calculation rule

`ДА` is written when the entire current working composition has been fully fulfilled through submitted sales. Both products and services are included. Drafts are not treated as submitted sales.

`НЕТ` is written when:

- an item or part of its quantity remains unfulfilled;
- a manager adds a new item;
- the quantity of an existing item is increased;
- a sale has been created but not submitted.

On a customer return, the returned item is reduced or removed from the current working composition and does not become a new unfulfilled remainder.

The backend recalculates the field after relevant composition and inventory-document changes. Users must not edit it manually.

## Separate overall-status idea

An overall status such as `Procurement`, `Ready for installation`, or `Installation` is not currently implemented. If required, it should be a separate list field, not mixed with the full-fulfilment flag.

Before implementing it:

1. agree on the final state set;
2. inspect existing portal fields and automation;
3. decide whether multiple states may exist simultaneously;
4. test field changes and triggers in a separate pipeline.

The full-fulfilment field remains an independent machine-readable flag.
