# Bitrix24 REST pitfalls and hard limits

[Русская версия](../b24-rest-grabli.md)

Everything below was verified with live calls against the `umniydom.bitrix24.ru` SaaS portal. We have no database or portal-source access; integration uses REST only. Dates show when each finding was verified. **The main meta-pitfall: the `methods` list is incomplete. A method's existence can only be confirmed by calling it** (a validation error means it exists; `ERROR_METHOD_NOT_FOUND` means it does not).

## Wall 1 (SOLVED 2026-06-11): order ↔ deal relation

The deal card displays sales, but neither the internal relation table nor the standard REST API exposes that link. **The way through is the hidden `crm.orderentity.*` family** (absent from `methods`):

- `crm.orderentity.list {filter:{orderId | ownerId, ownerTypeId:2}, select:['*']}` → `{orderId, ownerId, ownerTypeId}` — supports filtering by either order or deal, verified live;
- `crm.orderentity.add {fields:{orderId, ownerId, ownerTypeId:2}}` — creates the relation;
- `crm.orderentity.deleteByFilter {fields:{...}}` — removes it.

## Wall 2 (STILL STANDING): dispatch warehouse through REST

- `sale.shipmentitemstore.*`, `sale.storebarcode.*`, `sale.basketitemreservation.*`, and `crm.reservation.*` return `METHOD_NOT_FOUND` (dozens of candidate names tested on 2026-06-09/11).
- A deal product row does not accept `storeId` through `crm.item.productrow.update`: `INVALID_ARG_VALUE: Field 'storeId' not available for update` (2026-06-11). The native mechanism writes it internally.
- Submitting a `sale.shipment` without a warehouse fails with `DEDUCTION_STORE_ERROR`. **Conclusion: REST cannot construct and submit a real sale end to end.** We can create a draft; a user selects the warehouse and clicks Submit in the native card.
- **The warehouse of a DRAFT can be read** through reservations: `sale.order.get → basketItems[].reservations[].storeId`. When a manager selects a warehouse in the draft, Bitrix24 creates a reservation. Its `quantity` may be 0, but `storeId` remains valid. After submission the reservation is consumed, and the warehouse of the completed sale cannot be read. Verified with a multi-warehouse order (order 722: warehouses 4/10/12/16 on different rows).

## Orders (`sale.order`) and side effects

- `sale.order.add` automatically creates a duplicate deal and contact for every order because CRM and orders are coupled. `externalOrder:'Y'` does not prevent it. Workaround: after creation, read `crm.orderentity.list`, locate the relation to a newly created foreign deal (guard: `DATE_CREATE` less than 15 minutes old), then call `deleteByFilter`, `crm.deal.delete`, and `crm.contact.delete`.
- Currency field is **`currency`, not `currencyId`**. Use `lid:'s1'`, `personTypeId:6` for an individual; 8 represents a legal entity.
- Order **`userId` is the employee/manager, not the customer**, verified against native sales. Customer data lives in order properties: `sale.propertyvalue.list` (for person type 6: property 40 “First name Last name”, 42 Email, 44 Telephone, 52 Address). Write with `sale.propertyvalue.modify`, format `{fields:{order:{id, propertyValues:[{orderPropsId, value}]}}}` — verified live on 2026-06-12 with `test-propertyvalue-modify.ts`, order 966. If property 40 is empty, the sales card displays a technical login such as **`CONTACT_<id>`**. Customer details must be written for every shipment; the deal contact may have been added after the order was created.
- Native partial-delivery model: **one order → multiple shipments** (`#N/2, /3, /4`). Bitrix24 keeps the unshipped remainder in a system shipment (`system:'Y'`); filter these out of user-facing lists.

## Basket-row relation to deal product rows: `crm_pr_`

`sale.order.get → basketItems[].xmlId === 'crm_pr_<N>'`, where N is the CRM product-row ID. Resolve it with `crm.item.productrow.get {id:N}` → `{ownerType:'D', ownerId:<dealId>}`. Coverage on the portal is effectively complete. Notes:

- `.get` returns the row under **`productRow`**, not `item`;
- `crm.item.productrow.list` requires **`'=ownerType'`** in the filter, including the equals sign;
- when creating basket rows manually, set `xmlId: crm_pr_<rowId>` to match the native structure.

## Product-row and catalogue types (the “missing monitor” bug, 2026-06-11)

- Deal row `TYPE`: **1 = product, 4 = variation/SKU (also a product), 7 = work/service.** Filter as “service = 7, everything else = product”, otherwise variations disappear while their value remains in the total.
- Catalogue: iblock **24** = products (type 1 product, 3 SKU parent, 7 service), iblock **26** = variations (type 4, `parentId`). Stock belongs to variations. SKU parents are stockless containers.
- `catalog.product.list` requires `iblockId` in `select`; prices come from `catalog.price.list {catalogGroupId:2}` (`BASE` is retail); stock comes from `catalog.storeproduct.list` (without an amount filter, it also returns zero rows).

## Legacy versus modern product-row API

`crm.deal.productrows.get` (legacy) returns UPPER_CASE and includes `STORE_ID`, `RESERVE_ID`, `RESERVE_QUANTITY`, and `DATE_RESERVE_END`. `crm.item.productrow.*` (modern) returns camelCase and includes `storeId`, which is read-only for writes. Product rows from submitted sales have `storeId` because the native mechanism writes it.

## The frontend BX24 SDK is unreliable

`app.option.get`, `crm.deal.productrows.get` on newly created deals, and initialisation after returning from native screens may hang. Use the server-side client for all important calls; use `withTimeout`, `withRetry`, and graceful fallbacks elsewhere. User symptoms include an empty tab after adding an item and a 15-second timeout.

## Procurement smart processes (researched 2026-06-11, Vladimir's automation)

- Deal: `UF_CRM_1750389326` “Is equipment ordering required?” (86 Yes / 88 No), `UF_CRM_1777817683` “Procurement request created” (duplicate-prevention checkbox).
- **Procurement** entityTypeId **1110** (category 114): title `Delivery No. N_<dealId>_<name>`, `parentId2` = deal, item list in `ufCrm38_1777818101`, number in `ufCrm38_1777817940`, destination warehouse in `ufCrm38_1778141770` (element from **iblock 60**; the webhook lacks the `lists` scope).
- **Product item** entityTypeId **1114** (category 116): quantity `ufCrm40_1777821192`, source/destination warehouses from iblock 60, plus multiple technical automation fields.
- Lifecycle: the request is created EMPTY → manager sets a date and warehouse and advances the stage → **automation creates item rows**, grouping, transfers, and tasks. **Do not create 1114 rows ourselves**; that would break the pipeline. The automation is not triggered merely by the Yes field (deal 36742 has Yes but no request); it is probably stage-triggered.
- Other portal processes: 1038 Equipment Order, 1042 Site Visit, 1048 Installation, 1052 Cash Registers, 1070 Supplier Order, 1084 Transfer, 1114 Product Item.

## OAuth local application (mobile mode)

- Bitrix24 **ignores `redirect_uri`**: the code is sent to the registered `/app/handler`. Exchange it at `https://oauth.bitrix.info/oauth/token/`; `client_secret` is mandatory.
- `tok.domain` from the exchange is `oauth.bitrix.info`, **not the REST host**. Send REST requests to the portal domain.
- Opening a portal application in mobile web can crash the portal UI for all users; the standalone `/m` page is safe.

## Other findings

- `entity.*` works only in application context, not through a webhook; `entity.add` requires administrator access.
- `sale.shipment.list` occasionally returns a network `fetch failed`; retry it and add retries to all scripts.
- A sales-card URL uses the shipment ID: `/shop/documents/details/sales_order/<shipmentId>/`. A deal uses `/crm/deal/details/<id>/`. A smart-process item uses `/crm/type/<typeId>/details/<id>/`.
- A newly deployed bundle may return 404 during the first few seconds of warm-up; retry the request.
