# Features and screens

[Русская версия](../features.md)

This list describes delivered user-facing functionality. The availability of individual actions depends on the employee's Bitrix24 role.

## `Products 2.0` deal tab

- products and services in one working deal composition;
- adding items from our product catalogue;
- editing quantity, price, and discount;
- grouping by phases and commercial-proposal variants;
- warehouse stock checks;
- procurement requests for selected items;
- sales with warehouse selection;
- customer returns;
- commercial proposal and Excel export;
- contract generation;
- list of deal documents.

The contract builder reads the positions from our deal interface and supports all six of our legal entities. A manager selects the template, our legal entity, customer type, date, work duration, and site address. Contract numbers are assigned automatically per legal entity. VAT is derived automatically: 5% for sole proprietors and 22% for LLCs.

The universal work contract is currently enabled. The supply contract, design contract, and universal Smart Homes contract are shown as in preparation and cannot be generated until their reviewed Word templates are connected.

The standard Bitrix24 product section must not expose a second, independent editor for the same working composition.

## Products and services catalogue

- catalogue search and browsing;
- filters by section, warehouse, and availability;
- retail and purchase prices;
- total stock and stock by warehouse;
- our own product card instead of the standard Bitrix24 card;
- image, manufacturer, model, SKU, and section;
- description and specifications;
- new product creation;
- editing allowed fields and prices;
- Excel comparison between the inventory core and the Bitrix24 catalogue.

Technical strings such as `Б24 productId=...` are not treated as descriptions and are hidden. The filtering mechanism is extensible, but quality statuses for individual units are not yet implemented.

## Procurement

The left menu is organised into four groups.

### Fulfilment and orders

- Fulfilment and orders;
- Incoming retail-location requests;
- Purchasing;
- Logistics.

### Inventory documents

- Receipts;
- Sales;
- Write-offs;
- Returns.

### Stock and reports

- Stock;
- Reports → Product movement.

### Marketplaces

- sales;
- bundles;
- returns against a selected sale.

Marketplace sales include items with positive stock in the `Shelly` and `Маркетплейс` warehouses. A return starts by selecting a submitted sale and may include several of its rows and quantities; current stock does not hide items that have already been sold.

## Inventory management

- retail-location requests;
- transfer orders and documents;
- picking, dispatch, receipt, and verification;
- receipts;
- write-offs;
- sales and returns;
- product-movement journal;
- stocktakes.

A draft does not affect stock. Stock changes only after the ERPNext document is submitted.

## Stocktaking

- creating stocktakes for selected warehouses;
- assigning participants;
- mobile counting through `/m`;
- comparing physical count with recorded stock;
- generating adjustment documents;
- saving and submitting after review.

## Repairs

- intake of customer and pre-sale repairs;
- customer and equipment data;
- serial number, fault, comments, and photographs;
- workflow statuses;
- internal and customer prices;
- price-approval request;
- a paid repair is stored in the core deal plan as the real non-stock service `19108`, while Bitrix24 shows only the deal's collapsed total service row;
- legacy free-text `Платный ремонт` rows are safely migrated to the core service on the first deal action;
- release warehouse;
- print forms and files on Bitrix24 Drive;
- search by repair number and telephone.

## Reports

- sales for a selected period;
- product movement;
- history of an individual item;
- Excel catalogue comparison.

The `Reports` group already has its own place in Procurement and will be expanded.

## Upcoming catalogue changes

The following are planned but are not considered delivered:

- normalisation of manufacturers, models, and descriptions;
- duplicate reporting and safe duplicate handling;
- quality statuses for specific product quantities;
- moving terms such as `stock`, `display item`, or `clearance` from names into structured statuses.

These changes require an extension of the ERPNext model and a dedicated overnight maintenance window.
