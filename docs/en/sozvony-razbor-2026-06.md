# Customer-call review (23–24 June 2026)

[Русская версия](../sozvony-razbor-2026-06.md)

> Historical record of requirements as stated during these calls. This is not a description of the current implementation and not an operational guide. See [features.md](features.md) for current behaviour.

Sources: recordings N350 (23 June, 1 hour) and N354 (24 June, 1 hour 10 minutes). Original materials are stored outside the repository. Customer: **Vladimir Dranishnikov** (owner and canary user `'1'`). Participants: Danya (procurement/repairs), Pasha (system administrator responsible for the VPS), Dmitry Yuryevich (payment approval), and an external Bitrix24 integrator.

> The customer usually points at the screen and finds it difficult to describe details verbally, so screenshots were captured for key moments.

---

## Main conclusion: why the smart-process research mattered

Procurement is built **on top of Bitrix24 smart processes already created by the customer**: Procurement (1110), Supplier Order (1070), Transfer (1084), Approval (1100), Equipment Order (1038), and Product Item (1114). Research confirmed that they can be fully read and written through REST.

The key payment-approval mechanism: a Bitrix24 business process **cannot be launched directly through the API**, but creating a smart-process item can trigger one. This is the intended integration path identified during the call.

The payment-approval smart process was to be delivered by the external Bitrix24 integrator in approximately 1–1.5 weeks. We would integrate with it. Until then, we were not to change business processes; Vladimir planned to ask the integrator not to touch product/service relations handled by us.

## A. Deal products tab

- Responsive layout and 100% payment display had already been delivered before the second call.
- Long warehouse lists in a row must not increase row height; abbreviate them and show the complete list in a tooltip.
- Remove a separate “transfer / change quantity and price” button; edit inline.
- **Order product**: manager clicks the action → sees only products, excluding services, from the proposal → removes unnecessary ones → enters date, destination warehouse, and comment → creates an order for procurement. The manager receives a tracking link.
- **Two quantity columns**: quantity in the proposal, used for the proposal total, and quantity dispatched. A deal may have several dispatches.
- **Price remains editable until the deal closes**, because larger projects may require final adjustments such as extra cable.
- Services-only filter, row deletion, dispatch checkboxes, and a discount field.
- Prevent negative stock: if one unit is available, two cannot be dispatched.

## B. Procurement workspace

- A manager creates an order from the deal tab; it enters the procurement queue.
- Procurement left menu: stock by warehouse, active/inactive orders, logistics, purchasing, and warehouse documents.
- Each request has a tree of items. Procurement assigns a source to each one (warehouse A, warehouse B, or purchase), saves it, and the system creates child logistics and purchasing workflows.
- A **manager never chooses the source warehouse**. Only procurement has the full picture and optimises logistics. The manager interface must not offer that choice.
- Do **not** aggregate identical items from different requests: provenance and condition may differ, for example factory-sealed versus a display unit.
- A manager may request a standalone transfer for a retail location, outside a proposal, by specifying the needed product and a note but not a source warehouse. It enters the procurement queue without a deal relation.

## C. Transfers with real in-transit stock

- **Transit warehouse**: after dispatch, goods belong neither to the source nor destination warehouse until accepted. One transfer follows source → transit → destination.
- Receiving at a retail location: the manager sees incoming transfers, ticks what arrived, and confirms. Excess or shortage is highlighted in red.
- Dispatch: the manager ticks what was handed to the driver, and procurement is informed.
- To avoid hundreds of clicks by procurement, retail-location managers dispatch and receive, while procurement completes the chain and submits the transfer after confirming arrival.
- Bitrix24 chat notifications, similar to task notifications, should ask users to dispatch or receive and include a link.
- The intended behaviour is a simplified 1C-style workflow.

## D. Receipts, purchasing, write-offs, and reports

- Procurement creates purchase and logistics requests. An ordinary receipt also covers goods found in an office and added to stock.
- Managers may create draft receipts and write-offs for procurement review, for example a locally purchased item or defective goods. Write-offs require approval.
- **Product movement report**: select a product and see when and where it moved. This was considered essential.

## E. Repairs

- Repairs should appear in retail-location stock so that a stocktake can distinguish repair items from customer property.
- A repair item should be named **“repair + model + serial number”**, preventing accidental sale and making it visible during stocktaking. It is written off when returned to the customer.
- Repair warehouse: shipment to repair moves the item into a repair or transit warehouse; return brings it back to the retail location. Statuses provide tracking.
- A paid repair creates a deal for the lead, using the existing payment business process.
- Remove the Repairs pipeline: create the deal under Quick Sales and move it to Projects when installation is needed. Closing a warranty proposal should create a sale of the item.
- A repair release form was planned for later.

## F. Accounting and payment approval

- Payment approval flow: procurement opens a delivery/purchase, starts payment approval, attaches an invoice and comment, then the manager, Dmitry Yuryevich, and accounting approve and pay. The current email-based process was considered unsuitable.
- Invoice creation: create an accounting smart-process item, copy products, and allow choosing which items to invoice.
- The integration is triggered by creating a smart-process item. At the time of the calls, the external integrator's approval process was still pending.

## G. Serial numbers: next stage, not current scope

- Serial-number tracking should use scanners at receipt and prevent substitution disputes. It was scheduled after stocktaking and stabilisation.

---

## Explicitly deferred at the time

- Payment-approval business processes: waiting for the integrator's smart process.
- Serial numbers: next stage.
- Copying the paid amount from a deal into a proposal: non-critical.
- Repair release form: later.

## Near-term scope

This section records the near-term scope discussed during those calls, which Vladimir estimated at roughly two days. Actual delivered behaviour and later changes must be checked against [features.md](features.md) and the code.
