# Smart Home: user guide

[Русская версия](../user-guide.md)

## Most important rule

Stock changes only after a document is submitted. If a button press times out or the connection drops, check the journal first: pressing it again may create a duplicate.

## 1. Deal products

Open a deal and select the `Products 2.0` tab.

### Add a product or service

1. Click `Add product`.
2. Find items in the Product Catalogue.
3. Enter the quantity.
4. Confirm the selection.
5. Edit the row's price or discount when required.

If the product does not exist, create it through the Product Catalogue and then return to the deal. Do not create a substitute row with an arbitrary name.

### Variants and phases

Variants are used until the customer selects the final composition. Phases divide equipment and work into delivery stages. Once procurement or sales have begun, structural changes may be restricted to preserve document relations.

### Commercial proposal and Excel

- `Proposal` creates a customer-facing print form;
- `Download Excel` exports products, services, and totals;
- `Deal documents` lists documents already created.

### Procurement request

1. Select the required products with checkboxes.
2. Click the order action.
3. Verify the quantity and destination warehouse.
4. Add comments to individual items.
5. Submit the request.

Do not order an item again when it is already marked as ordered.

### Sale

1. Select products ready for dispatch.
2. Verify the quantity.
3. Select a warehouse.
4. Create the document.
5. Submit it after review.

Until submission, the document remains a draft and does not affect stock.

### Customer return

Click `Return`, select the source sale, choose the returned rows and quantities, and select the receiving warehouse. Return only goods that were actually received.

## 2. Contract

Click `Contract` on the deal tab.

Generation is available when:

- the deal contains products or services;
- a customer is selected;
- the required company or contact details are filled in.

Verify:

1. contract template;
2. selected legal entity;
3. customer type: LLC, sole proprietor, or individual;
4. contract date;
5. work duration and calendar or working days;
6. site address;
7. signatory's full name and position.

The contract number is assigned automatically per legal entity. VAT is not selected manually: sole proprietors use 5%, while LLCs use 22%.

The universal work contract is currently available for generation. Other templates in the list are marked as in preparation.

A first name such as `Danila`, without a surname and patronymic, blocks contract generation. Correct the customer card in Bitrix24 first. Sole proprietors and LLCs also require organisation, address, and bank details. Object-address coordinates are excluded from the contract.

## 3. Products and services catalogue

Clicking a product name opens our product card.

It contains:

- image;
- manufacturer and model;
- SKU and section;
- description and specifications;
- retail and purchase prices;
- stock by warehouse.

Users with the required permissions may edit a card and create a product. The `Новый товар`
button is available in the products catalogue and under `Снаб → Остатки` for procurement users.
The form accepts prices, status, a short description, and an image. Selecting a section loads a
specification template derived from existing structured cards in that section; extra fields may be
added manually. Before saving, make sure it is not a duplicate of an existing item.

Permission to edit an existing product card is independent from permission to change prices. Edit
mode can add or replace the product image; the application resizes it to a safe size before upload.
Price fields are disabled when the user may edit the card but not its prices. On first save, a
legacy card without structured specifications receives the new structure while preserving its
existing description.

The text `Б24 productId=...` is a legacy catalogue technical reference, not a description.

## 4. Procurement

### Fulfilment and orders

- `Fulfilment and orders` — shared work queue;
- `Incoming retail-location requests` — new retail-location demand;
- `Purchasing` — supplier orders and receiving;
- `Logistics` — transfers between warehouses.

### Inventory documents

- `Receipts`;
- `Sales`;
- `Write-offs`;
- `Returns`.

Create a document, verify its contents, and only then submit it.

### Stock and reports

- `Stock` shows availability by warehouse;
- `Reports` contains `Product movement`.

### Marketplaces

Products with positive stock in the `Shelly` and `Маркетплейс` warehouses are available for marketplace sales.

Return flow:

1. select the original sale;
2. expand its contents;
3. select one or more items;
4. enter quantities;
5. select the `Shelly` or `Маркетплейс` warehouse;
6. submit a single return.

An item sold down to zero still appears in the source sale.

## 5. Transfer

Standard flow:

1. a request or order is created;
2. procurement creates a transfer;
3. the source warehouse picks the goods;
4. goods enter the `In transit` status;
5. the destination warehouse receives them and records discrepancies;
6. procurement reviews and submits the document.

Do not treat goods as available at the destination warehouse before the transfer is complete.

## 6. Stocktaking

1. Create a stocktake and select warehouses.
2. Assign participants.
3. Each participant opens the link or mobile mode and records the physical count.
4. The owner reviews discrepancies.
5. The system generates adjustment documents.
6. Documents are submitted only after final review.

## 7. Repairs

At intake, record the customer, telephone, equipment, serial number, fault, and included accessories. Attach photographs when they are relevant to condition.

Use the module statuses for subsequent workflow, not free-form text. After a repair is transferred to the office, some fields are locked and can be changed only by responsible employees.

Search by repair number or customer telephone.

## 8. When something goes wrong

Record:

- deal/document link or ID;
- exact time;
- error text;
- action clicked;
- whether it was clicked again.

Do not create a second operation until the first has been confirmed absent. Send the details to the system owner.
