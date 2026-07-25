# Passing the service total to Installation

[Русская версия](../montage-service-sum.md)

## Deal field

- Name: **Service total**
- Bitrix24 custom-field ID: **2788**
- Internal code: **`UF_CRM_SERVICE_SUM`**
- External code: **`B24_APP_DEAL_SERVICE_SUM`**
- Type: **Money**
- Currency: **RUB**

The application totals only rows in the current working deal composition marked as services/work:

`Σ (final price after discount × quantity)`

When there are no services, it writes `0 RUB`. The field is recalculated when the working composition changes, a proposal variant is selected, or an item is returned.

For compatibility with native Bitrix24 product rows, a technical service row named **`Отгрузка подтверждена на сумму`** (“Dispatch confirmed for the amount”) is used. Our tables and contracts hide it as a technical row; managers must not interpret it as a separate service.

## Business-process configuration

In the **Create Installation smart-process item** action, set:

- **Manual total calculation** — `Yes`;
- **Currency** — `Russian rouble`;
- **Amount** — deal field `UF_CRM_SERVICE_SUM` (`Service total`).

The smart-process field **Engineer visit fee (when chargeable)** is not used for this purpose. It represents a separate engineer payment, not the value of work in the deal.
