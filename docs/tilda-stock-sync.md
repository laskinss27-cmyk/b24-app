# Tilda stock projection

Status: production automation enabled on 2026-08-21 for the `Shelly Россия`
project (`projectid=5103503`). A separately authorized stock-only publication
reached exact ERP/Tilda parity and preserved the non-quantity catalog hash;
the guarded two-minute scheduler subsequently passed its manual and scheduled
no-op gates. The `Просмарт` project was not used or changed.

## Source of truth and identity

- ERPNext remains the only source of physical stock. Reads use the official
  ERPNext API; application code never reads ERPNext MariaDB tables directly.
- `b24_app.tilda_product_mappings` owns the storefront identity link. Historical
  Tilda SKU, Tilda UID and External ID remain separate from the ERP Item code.
- Tilda is a one-way projection. It never restores or writes ERPNext stock.
- The marketplace-only ERP field `b24_marketplace_old_id` is not reused for
  Tilda identities.

The 2026-08-20 Tilda export contains 177 rows: 131 parents and 46 variants. Of
150 stock-bearing rows, 134 now have a confirmed ERP Item mapping. Sixteen
products do not exist in ERPNext and are explicitly `ignored`; they are not
created automatically. The remaining 27 rows are non-stock parent rows without
their own SKU and are also `ignored`. There are no unresolved rows in the
versioned 2026-08-21 seed. The seed preserves all historical Tilda SKU values.

## Local foundation

- `0006_create_tilda_product_mappings.sql` is DDL only. It creates no rows and
  changes no runtime path.
- `tilda-product-mappings-2026-08-21.csv` is a versioned one-shot backfill input,
  not runtime JSON state.
- `tilda:mappings:backfill` is manual, uses the separate DML/backfill account,
  acquires a MariaDB lock, validates UID/External ID conflicts and writes in one
  transaction. It is never called at backend startup.
- The preview service reads stock-bearing SQL mappings, requests ERP stock only
  for `confirmed` ERP Items, projects only the active leaf warehouse `Shelly`,
  verifies that both this warehouse and every confirmed Item are active, distinguishes an active
  zero-stock Item without a `Bin` row from a missing Item, rejects an incomplete
  ERP response, clamps negative totals to zero, floors fractional totals and produces a
  CommerceML document plus a timestamp-independent SHA-256 projection hash.
- The protocol client is used only by isolated worker commands: it validates the
  official connector host, maintains one authenticated session, enforces the
  advertised file limit and accepts only `import*.xml`/`offers*.xml` filenames.
  There is no runtime publishing endpoint; production scheduling is the external
  guarded cron described below.
- Outgoing incremental offer rows contain only the existing Tilda External ID
  and numeric quantity. They contain no title, SKU, description, price, image,
  URL, category or SEO value.
- The public-catalog reader computes a stable SHA-256 over all returned product
  and variant fields except `quantity`. Any content change before or after a
  stock operation stops the run; a quantity-only change leaves this hash
  unchanged.

The public catalog currently reports a blank quantity (Tilda unlimited stock)
for two confirmed mappings: UID `124782539723`, SKU `111348`, ERP Item `20534`;
and UID `708983630233`, SKU `111352`, ERP Item `20518`. A numeric CommerceML
rollback cannot faithfully restore that state. The first reversible projection
therefore contains 132 offers and explicitly blocks those two rows. They remain
untouched until unlimited-stock rollback is separately proven.

## Verified production foundation (2026-08-21)

- Pre-DDL backup `20260821_140011-b24_app-database.sql.gz` passed local
  checksum/gzip checks and Bitrix Disk read-back.
- The one-shot migration runner applied only
  `0006_create_tilda_product_mappings.sql` with SHA-256
  `b96e52a710b8ca2549f8271110d2cf801e4b90f81a881328a7e1a797ed6023f5`.
  The table was independently verified as 15 columns, 8 index rows, 5 CHECK
  constraints, InnoDB and `utf8mb4_unicode_ci`.
- Post-DDL backup `20260821_140418-b24_app-database.sql.gz` restored into the
  isolated `b24_app_restore_20260821_140418`. Source and restore matched across
  7 tables, 81 columns, 45 index rows, 27 CHECK definitions and every table
  checksum.
- The DML-only backfill wrote 177 mappings in one transaction: 134 confirmed,
  43 ignored and zero unresolved. A repeat kept the mapping-table checksum
  unchanged at `616442171`.
- Post-backfill backup `20260821_141039-b24_app-database.sql.gz` passed external
  read-back and restored into `b24_app_restore_20260821_141039`; structure and
  all seven table checksums matched, including the exact 177/134/43 mapping
  counts.
- A fresh official ERPNext API preview verified all 134 active Items and
  produced 134 offers, skipped the 16 stock-bearing ignored rows, found 63 zero
  and 71 positive quantities, total quantity 1274 and projection hash
  `4889fd511f150c38441426704cf035d0263b85d22f63599663f0ee49aec82110`.
  The audit is root-only at
  `/root/b24-app-audits/20260821-1408-tilda-stock-preview.json`.
- Production remained on `b24-app:ef4fecb`, restart count zero,
  `B24_APP_DB_MODE=readiness`, without Tilda or one-shot credentials. Internal
  and public health, readiness, ERP read and `erpnext_frappe_network` passed.
- The hardened stock-only preparation at `2026-08-21T15:03:06.204Z` produced
  132 projection and 132 rollback offers, 77 differences, public content hash
  `9665ff7ff329cccd1553c9a6671596c4c6d79cbaba2d824963b8cc217325beea`,
  projection XML SHA-256
  `380bc937c841564c00c2f15d205df9b8052c90885774c041641cd1feda0764f5`
  and rollback XML SHA-256
  `96c8788f0a0385e7726f64ed63b9bffbded1c3f6eb1f81454bed97eb5619ebb6`.
  The XML was independently checked to contain no card-content or price tags.
  Artifacts are root-only under `/root/b24-app-audits/20260821_152500-*`.

The two backup jobs crossed the configured retention boundary and removed the
oldest pairs `20260820_085056` and `20260820_085654` locally and from Bitrix
Disk. Fourteen current backup pairs remain; the new safety, post-DDL and
post-backfill backups are retained. One-shot credential-bearing containers
were removed after verification. Restore schemas and root-only staging remain
preserved until an explicit cleanup decision.

## First production run: required gates

Tilda's official CommerceML guide describes a complete exchange as
`checkauth`, `init`, upload of `import.xml`, upload of `offers.xml`, then both
imports, all within one session:
https://help-ru.tilda.cc/online-store-payments/1c-commerceml
Before the first stock write, run one separately approved idempotent canary
containing a single already-equal numeric quantity. Continue only if Tilda
returns protocol `success` for both files and the public identity/quantity and
complete non-stock content hash remain unchanged.

The first authorized canary attempt uploaded the one-off `offers0_1.xml`, but
Tilda rejected the subsequent `mode=import` response before verification could
complete. The client stopped and no full projection was sent. An independent
fresh public/ERP audit at `2026-08-21T15:07:53.860Z` proved that the complete
non-stock content hash remained exactly
`9665ff7ff329cccd1553c9a6671596c4c6d79cbaba2d824963b8cc217325beea`,
the canary stayed `7`, and the catalog still had the same 77 stock differences.
The temporary credential file and one-shot container were removed. This attempt
does not pass the canary gate; a retry requires separate approval after the
client records Tilda's bounded, credential-redacted protocol failure detail.

The separately approved diagnostic retry returned the exact sanitized response
`failure | Import file is empty`. A second independent public/ERP audit at
`2026-08-21T15:15:38.734Z` again matched the complete non-stock content hash,
kept the canary at `7`, and retained 77 stock differences. The retry therefore
made no catalog change. The next transport candidate sends the UTF-8 XML bytes
as `application/octet-stream`, matching the 1C exchange contract that transmits
file contents in the POST body; it must pass the same separately approved
single-offer canary before any full projection.

The authorized binary-POST canary returned the same `Import file is empty`
failure. A third independent audit at `2026-08-21T15:19:49.273Z` again proved
the exact content hash, quantity `7`, and 77 differences were unchanged. This
rules out the request content type as the cause and points to Tilda's documented
requirement for the paired exchange. The empty incremental catalog candidate
was never executed and has been discarded: the official CommerceML schema
requires at least one `Товар`, so `<Товары/>` is not a valid safety anchor.

On 2026-08-21 the Tilda import settings were manually verified and saved with
`Создавать новые товары`, `Создавать новые варианты`, `Обновлять цены`,
`Обновлять название и описание`, `Обновлять артикул`, `Обновлять раздел`,
characteristic/variant-property updates and image acceptance disabled. Only
`Обновлять остатки` is enabled.

The replacement candidate follows the complete six-step session and uses one
existing non-variant product whose quantity is already equal on both sides:
UID `400979429632`, SKU `111081`, External ID `a86C3Xdfs0l5Ud7GHXUT`, title
`Shelly Pro Dual Cover/Shutter PM`, quantity `18 -> 18`. The valid incremental
`import0_1.xml` necessarily contains its exact existing External ID, exact
existing title and the standard `шт` base unit. It contains exactly one product
and no SKU, description, price, image, URL, group/category, characteristic or
SEO field. The `offers0_1.xml` uses the standard
`ИзмененияПакетаПредложений` structure and contains only the same External ID
and quantity. The title is not an enabled Tilda update field, but it is retained
solely because CommerceML requires a product name in a valid catalog document.
The separately approved canary completed at `2026-08-21T15:52:46.401Z`.
`import0_1.xml` returned `success`; `offers0_1.xml` returned two bounded
`progress` responses and then `success`. The quantity remained `18`, the full
public non-quantity content hash remained exactly
`9665ff7ff329cccd1553c9a6671596c4c6d79cbaba2d824963b8cc217325beea`,
the ERP projection hash remained exactly
`4889fd511f150c38441426704cf035d0263b85d22f63599663f0ee49aec82110`,
and the catalog retained 77 stock differences. The independent pre/post audits
are root-only under `/root/b24-app-audits/20260821_185300-*` and
`/root/b24-app-audits/20260821_185301-*`. The temporary CommerceML credential
file and all one-shot containers were removed. Production remained on
`b24-app:ef4fecb`, restart count zero, in `erpnext_frappe_network`, and internal
health remained successful.

The public content hash covers every field returned by Tilda's public product
API except quantity. It does not claim visibility into private SEO fields that
the public API does not expose; protection for those fields is the disabled
title/description and all other card-content import settings plus the absence of
SEO tags in both XML files.

The first authorized full 132-offer publication was attempted from the fresh
snapshot `20260821_190100`. Tilda accepted both CommerceML files at the protocol
level, but the public verification timed out because UID `293785910061` did not
receive its projected quantity. The publisher immediately sent the complete
numeric rollback and independently verified it. Snapshot `20260821_190101`
confirmed the original 77 differences, projection hash
`4889fd511f150c38441426704cf035d0263b85d22f63599663f0ee49aec82110`
and public non-quantity content hash
`9665ff7ff329cccd1553c9a6671596c4c6d79cbaba2d824963b8cc217325beea`.
No catalog or stock change remained. The credential file and one-shot
containers were removed; the production backend was unchanged and healthy.

The failed full attempt included only the earlier no-op anchor in
`import0_1.xml`, while the other 131 products appeared only in `offers0_1.xml`.
This initially suggested that every offer also had to participate in that
exchange's catalog file. A subsequent authorized one-product test included UID
`141488884302` in both files and attempted the exact reversible change `12 ->
11`, but the public verification again timed out without observing `11`.
Automatic rollback was sent and independently verified: the product was `12`,
the catalog retained all 77 differences and both hashes remained exact. This
disproves the product-membership explanation as sufficient by itself.

Comparison with the official 1C CommerceML schema then exposed a concrete XML
defect: both generated documents omitted the required default namespace
`urn:1C.ru:commerceml_2` even though the schema uses
`elementFormDefault="qualified"`. Tilda's protocol-level `success` therefore
did not prove that the namespaced CommerceML entities had been recognized. The
corrected candidate added the official default, `xs` and `xsi` namespace
declarations to both files and retained the same one-product `12 -> 11` gate.
The authorized run `20260821_194000` again completed at the CommerceML protocol
level but did not expose quantity `11` through the public catalog before the
verification timeout. The automatic rollback and independent run
`20260821_194001` confirmed quantity `12`, all 77 original differences, the
exact projection/content hashes, both unlimited exclusions and an unchanged
healthy backend. The secret and one-shot containers were removed. Thus the
missing namespace was a standards defect that had to be fixed, but it was not
sufficient to attach these pre-existing Tilda products to this CommerceML
source.

The Tilda `История синхронизации` entry at `19:18:41` provided the missing
parser-level evidence: `Найдено товаров: 1, предложений: 0`. The catalog product
and its External ID were therefore recognized, while Tilda ignored every row
inside `ИзмененияПакетаПредложений`. This rules out source association as the
immediate cause and shows that protocol-level `success` was not an offer-count
confirmation.

The next candidate uses the ordinary `ПакетПредложений` element implemented by
Tilda's 1C workflow. To preserve the stock-only contract, it contains one
package-level service name and, for each offer, only the existing External ID
and integer quantity. It deliberately contains no product title, SKU,
description, price type, price, currency, image, category, property or SEO tag.
The corrected publisher still lists every future target in `import0_1.xml` with
only the required existing title and base unit. Another full run remains blocked
until the ordinary-package one-product test passes with the same verified
automatic rollback path.

The separately authorized ordinary-package canary `20260821_195000` passed.
Tilda changed UID `141488884302` from `12` to the ERP quantity `11`; the fresh
independent comparison `20260821_195001` reduced the catalog differences from
77 to 76, retained 131 parents, 150 stock rows and the two unlimited exclusions,
and preserved projection hash
`4889fd511f150c38441426704cf035d0263b85d22f63599663f0ee49aec82110`
and non-quantity content hash
`9665ff7ff329cccd1553c9a6671596c4c6d79cbaba2d824963b8cc217325beea`.
Three additional reads through the production network independently returned
the same content hash and quantity `11`. The root-only success audit is
`/root/b24-app-audits/20260821_195000-tilda-stock-publish-success.json`; the
temporary credential and one-shot containers were removed and the production
backend remained `b24-app:ef4fecb`, healthy, in `erpnext_frappe_network`, with
restart count zero.

One read from the development workstation returned a different non-quantity
hash while still showing quantity `11`; three immediate production-path reads
were stable on the audited hash. Treat this as an external cache/edge
inconsistency rather than silently accepting either value: production
automation must require repeated stable public reads before declaring content
parity.

The separately authorized full publication `20260821_201000` started from a
fresh snapshot with 132 reversible offers and 76 differences. It sent the
ordinary stock-only package and passed three consecutive full-catalog public
verifications. The immediate comparison `20260821_201001` and independent
read-only ERP/Tilda postcheck `20260821_201100` both reported zero differences,
131 parents, 150 stock rows, 132 reversible targets and the same two excluded
unlimited rows. The projection and non-quantity content hashes remained exactly
`4889fd511f150c38441426704cf035d0263b85d22f63599663f0ee49aec82110`
and `9665ff7ff329cccd1553c9a6671596c4c6d79cbaba2d824963b8cc217325beea`.
The root-only success audit is
`/root/b24-app-audits/20260821_201000-tilda-stock-publish-success.json`.
The temporary credential and one-shot containers were removed; production
backend `b24-app:ef4fecb` was not replaced or restarted and remained in
`erpnext_frappe_network`.

This established the verified parity snapshot used as the scheduler activation
baseline. The later guarded worker activation is recorded below; this historical
publication did not itself enable a scheduler.

1. Retain the exact pre-write public-catalog snapshot and generated numeric
   rollback file for the 132 reversible offers. Also export and retain a fresh
   Tilda catalog CSV if the administration UI is available. Tilda documents
   that UID is required to update existing products and recommends exporting a
   backup before import:
   https://help.tilda.cc/online-store/import-export
2. Only after a separate explicit approval, stop stock-changing work for the
   short final window, generate a second fresh preview, compare its hash and
   publish the 132 reversible quantities. Do not publish titles, descriptions,
   photos or prices. Do not touch the two unlimited rows.
3. Read the public catalog again and compare all 132 published quantities by
   UID/External ID. Resume work only after the comparison passes.

Rollback before the first authoritative publish is simply to leave publishing
disabled. After a publish, apply the generated pre-publish rollback XML and
verify the public catalog again; the retained CSV remains a secondary backup.
SQL rollback does not repair Tilda quantities, so the independent catalog
snapshot and rollback artifact are mandatory.

## Production automation

Automation was separately authorized and activated only after the SQL audit/run
record, distributed locks, projection-hash idempotency, bounded retries and
rollback gates passed. A failed ERP read stops the run; it is never converted to
an empty catalog or all-zero projection. CommerceML credentials remain outside
Git and are scoped only to this integration. The ordinary Tilda content API is
GET-only and is not treated as a catalog stock-write API:
https://help.tilda.cc/api

The intended initial cadence is a two-minute one-way reconciliation from the
official ERPNext API to Tilda, publishing only when the projection hash changes.
An ERP event hook may later reduce latency, but the periodic reconciliation
remains the safety net. Production cron now runs every two minutes from the
version-pinned `b24-app:05cdb20` image.

On 2026-08-25 the projection source was narrowed from the ERP-wide warehouse
total to the single active leaf warehouse `Shelly`. A read-only production
preview from the clean `05cdb20` image returned 134 confirmed offers, 16
skipped mappings, 66 zero and 68 positive quantities, total quantity 1225,
`sourceStore=Shelly` and projection hash
`144cae376caa2b157b1db4d8359d4333d3279267aad62faefad84bb81d7bc5a6`.
The first guarded manual cycle updated 19 of the 132 reversible quantities and
completed as `verified`; its before/after non-quantity content hash remained
exactly
`9665ff7ff329cccd1553c9a6671596c4c6d79cbaba2d824963b8cc217325beea`.
A second manual cycle and the first scheduler cycle both returned `no_op` with
the same Shelly projection and content hashes. Titles, descriptions, prices,
images, SKU, sections, characteristics and SEO fields were not published.

The cron line was disabled during the manual gate and re-enabled only after the
verified write and idempotent no-op. Root-only rollback snapshots are retained
under `/root/b24-app-ops`; the exact pre-change crontab is
`crontab.before-tilda-secret-rotation.20260825T155210Z`. Operational rollback is
still to install that snapshot (or remove the single Tilda cron line) and, if
required, run the reconciliation journal's retained numeric rollback artifact.

## Storefront availability presentation

The versioned `scripts/tilda-availability-status.html` snippet derives both its
visible status and the two large catalog filters only from Tilda's rendered
numeric `data-product-inv` value. A positive quantity is shown as `В наличии`;
zero is shown as `Под заказ` in both the catalog card and product detail. Blank
quantities remain unclassified because they mean unlimited/unknown stock in
Tilda. For zero-stock products the existing disabled Tilda button is relabelled
from `Нет в наличии` to `Под заказ`; it does not become an order action.

The snippet changes only the rendered DOM. It does not write product titles,
descriptions, characteristics, images, prices, SKU or SEO fields. The buttons
use a local `b24_stock=available|preorder` URL state and never click Tilda's
stored-characteristic checkboxes. An old `tfc_charact:10171262[...]` link is
replaced with the numeric URL and reloaded once, while unrelated native category,
price, search and sort parameters are preserved. Since the catalog is paged by
40 products, an active stock filter automatically follows Tilda's own load-more
control (maximum ten pages) before hiding non-matching cards. The legacy
`Наличие` filter group and duplicate product-characteristic row are hidden; the
stored characteristic itself is retained only as reversible historical data.

The original status-only revision was installed after the existing Yandex
Metrika HEAD code and all 23 pages of project `5103503` were republished on
2026-08-25. A fresh uncached
public check found 40/40 rendered catalog cards with statuses, including a
positive `В наличии` row and a zero-stock `Под заказ` row; the zero-stock detail
page kept its product description and showed `Под заказ` in both the status and
disabled button. The ordinary catalog URL initially returned an older CDN copy,
while a cache-busted request already returned the new HEAD code. A pre-existing
catalog-only `SyntaxError: Unexpected token '<'` reproduced on both the old page
without this snippet and the freshly published page; it is recorded as unrelated
and was not changed in this gate.

### Abandoned native availability publication path

The rendered status and Tilda's native characteristic filter were originally
separate data paths. A read-only public audit on 2026-08-31 found 28 stale
`Наличие` values among the 112 parent cards that have complete confirmed ERP
mappings: six needed `В наличии` and 22 needed `Под заказ` according to Shelly.

The guarded foundation proved the intended projection: a direct product is
`В наличии` when its Shelly quantity is positive; a parent with variants is
`В наличии` when at least one confirmed child variant is positive; otherwise it
is `Под заказ`. Fourteen ignored groups and five parents without a stock-bearing
SKU remain untouched. Missing ERP results and changed variant topology fail
closed.

Availability publication is intentionally a separate manual command at this
stage. It is not called by the normal backend or the scheduled stock/price
worker. Preparation requires an explicit `TILDA_AVAILABILITY_PROPERTY_ID` and
produces a deterministic projection, the exact previous characteristic values,
a no-op numeric offers anchor and hashes. Publication requires a fresh
confirmation string plus `TILDA_AVAILABILITY_SYNC=manual`, verifies all 131
parent identities and all 150 stock rows,
protects every public card field except current quantity, current price and the
single exact `Наличие` characteristic, and attempts the complete characteristic
rollback on failure.

Production canaries later proved that CommerceML characteristic updates are
full replacements, not field merges. A 112-parent publish therefore removed
unrelated multi-value characteristics. The exact 2026-08-20 Tilda CSV export
was validated against untouched cards and used to restore all affected data;
the final public check matched 112 target cards and 19 untouched cards exactly,
with prices, quantities and all non-characteristic content unchanged. Tilda's
`Обновлять характеристики` option is now off. Scheduled CommerceML continues to
publish only stock and opted-in prices. Native availability publication must
not be scheduled or retried.

The numeric two-button filter replaced the old checkbox interception code in
the catalog page's existing T123 block on 2026-08-31; only `/catalog` was
republished. The live verification loaded all 131 parent cards and produced 63
positive `В наличии`, 61 zero `Под заказ` and 7 blank/unclassified cards, with
no cross-category matches. The legacy characteristic filter is hidden in the
rendered catalog but retained in stored product data for rollback.

Commit `aaf8730` deployed this foundation to the normal production backend on
2026-08-31 without activating availability publication. The effective backend
environment has no `TILDA_AVAILABILITY_SYNC`; the scheduled stock/price cron
remains pinned to `b24-app:85a8218` and continued returning verified `no_op`
cycles. The new backend image `b24-app:aaf8730` passed an isolated read-only
state canary, internal and public health, readiness with SQL `up`, an official
ERPNext API read, the state/port/restart checks and explicit membership in
`erpnext_frappe_network`. The previous running image is preserved as exited
rollback container `b24-backend-prev-before-aaf8730` with exit code zero.

No Tilda setting, characteristic, catalog card, quantity, price, cron entry,
SQL data or source-of-truth switch changed in this deployment. The next gate is
a separately approved fresh production preparation followed by pausing the
Tilda cron, enabling only characteristic updates and running the already-equal
no-op parent canary.

## Retail price projection foundation

The price source is the official ERPNext `Item Price` API for price list
`Standard Selling`. `Standard Buying`, valuation rate and prices copied into
sales documents are not storefront price sources. Only one currently active,
positive RUB price per mapped ERP Item is accepted; duplicate active rows,
another currency, a non-positive value or a non-unit packing price fails closed.
A mapped Item without `Standard Selling` is reported and skipped, never
converted to a zero price.

Price publication is an opt-in extension of the same guarded CommerceML cycle.
`TILDA_PRICE_SYNC` defaults to `off`; with the flag absent/off the generated
offers XML and stock projection hash remain stock-only. When explicitly enabled,
the offers document adds only one CommerceML price type
`b24-app-standard-selling` and the existing offer's numeric `ЦенаЗаЕдиницу`,
RUB currency and unit coefficient. It does not add or update old price,
discount, SKU, title, description, images, section, characteristics or SEO.

The public reader keeps two hashes: the existing stock-only safety hash ignores
only quantity and therefore still detects any price movement while price sync is
off; the opt-in price safety hash ignores only quantity and current price while
continuing to protect old price and every other public card field. Numeric Tilda
prices are captured before publication and included in the rollback XML. A
blank Tilda price is not numerically reversible and is therefore excluded from
the first price projection without blocking stock reconciliation.

A read-only production audit on 2026-08-31 found 134 confirmed mappings. The
`Standard Selling` source had 129 unique positive RUB prices, no duplicates,
invalid values, zero values or non-unit packing prices; five mapped Items had no
retail price. Of the public Tilda rows, 95 prices already matched ERP, 31
differed, three were blank and none had an old price. This audit did not change
ERPNext, SQL, Tilda or the running worker. Before production activation the
Tilda CommerceML setting `Обновлять цены` must be enabled while every card
content setting and product/variant creation stays disabled. A separately
approved one-product numeric canary must prove both price application and exact
rollback before the full reversible set is published.

The price projection was activated on 2026-08-31 after deploying commit
`85a8218` with `TILDA_PRICE_SYNC=off`. The operator enabled only Tilda's
`Обновлять цены` import setting. Fresh snapshot `20260831_113000` identified
31 numeric price differences; the one-product canary changed Shelly BLU Gateway
(UID `486784300532`, SKU `111118`) from `2466` to ERP `Standard Selling`
`2150` while quantity stayed `62`. Three public reads verified the new price
and the protected card-content hash remained
`77e717cd1808e671920547ba4dc33e90534205ba72c5a8fe60463985f4704918`.

Fresh snapshot `20260831_113200` retained 30 differences. The full guarded
publication verified all 30 changes across 124 reversible numeric price
targets, preserved the protected content hash and retained its complete
numeric rollback artifact. Independent snapshot `20260831_113400` returned
zero stock-or-price differences. Five mapped ERP Items without a retail price,
three Tilda rows with a blank non-reversible current price and two unlimited
stock rows remained untouched.

The isolated worker env now has `TILDA_PRICE_SYNC=on` and cron is pinned to
`b24-app:85a8218`. Both the immediate manual cycle and the first scheduled
cycle returned `no_op`, `priceTargetCount=124`, `priceDifferenceCount=0`,
`missingErpPriceCount=5` and `blockedMissingPublicPriceCount=3`. Root-only
pre-activation rollback snapshots are
`/root/b24-app-ops/tilda-sync.env.before-price-20260831_113500` and
`/root/b24-app-ops/crontab.before-tilda-price-20260831_113500`.

## Twelve new Shelly products, 2026-09-03

Twelve workbook-marked ERP Items were created in Tilda through the authorized
CommerceML product-creation setting and assigned to the existing sensor,
display, button and accessory sections. The complete public read-back returned
`143 parents / 162 stock rows`; every new row had a unique Tilda UID, external
ID `b24-app-erp-<Item code>` and SKU equal to the ERP Item code. The original
150 stock identities remained present.

Commit `a146a81` contains the separate audited seed
`tilda-product-mappings-2026-09-03.csv` and one-shot DML entrypoint. The
least-privilege `b24_app_backfill` account exposed only
`SELECT/INSERT/UPDATE`; the guarded transaction added exactly 12 confirmed
mappings and moved SQL from `177/134/43/0` to
`189/146/43/0` total/confirmed/ignored/unresolved rows.

The post-backfill preparation passed the new guarded shape: 162 mappings, 146
offers, 16 skipped, 144 reversible numeric stock rows, the same two exact
unlimited exclusions, 136 numeric price targets, five missing ERP prices and
three non-reversible blank public prices. Four quantity differences and zero
price differences were found. The manual reconciliation changed exactly those
four quantities, preserved protected content hash
`09d0228697f8491569e395ec56d0053ddf047cd8be56703ee49bdc0ca97251e2`
and completed `verified`. Cron was then re-enabled as one `*/2` line pinned to
`b24-app:a146a81`; its first scheduled cycle returned `no_op` with 144 stock
targets and 136 price targets. The pre-enable crontab is preserved at
`/root/b24-app-ops/crontab.before-enable-tilda-a146a81-20260903`.

## Guarded reconciliation worker

The repository contains a one-cycle worker that remains disabled unless
`TILDA_STOCK_SYNC=on` is explicitly passed. The normal backend never calls it at
startup or through HTTP. Production activation is isolated in a versioned host
wrapper and one cron line; removing that line stops scheduling without changing
backend or ERPNext behavior.

Each cycle holds both a host `flock` and connection-scoped MariaDB `GET_LOCK`,
then reads 162 SQL stock mappings, active unexpired reservation totals for the
ERP warehouse behind `Shelly`, all 146 confirmed ERP Items through the official
API and the complete public Tilda catalog. The published quantity is
`max(0, floor(physical Shelly stock - active reservations))`; reservations do
not alter physical ERPNext stock. It requires the audited
shape `162 mappings / 146 projected / 16 skipped / 143 parents / 162 stock
rows / 144 reversible / 2 exact unlimited exclusions`. Any missing Item,
changed UID/SKU, incomplete page, unresolved shape or read error fails closed.
It never turns a failed read into zeros.

If all 144 reversible quantities already match, the worker makes no Tilda
request. Identical successful no-op states are deduplicated in SQL. If there is
a difference, it records a `running` audit row, publishes the same minimal
stock-only CommerceML documents used in the verified full run, and requires
three consecutive complete public reads with unchanged non-quantity content.
The existing verified rollback path runs on any publication/verification
failure. Interrupted `running` rows are marked failed by the next lock holder.

Migration `0007_create_tilda_stock_sync_runs.sql` contains only the bounded run
journal. The production `b24_app_tilda_sync` account is distinct from runtime,
migration, backfill and backup roles and receives only:

```sql
GRANT SELECT ON b24_app.tilda_product_mappings TO 'b24_app_tilda_sync'@'<SYNC_HOST_PART>';
GRANT SELECT ON b24_app.stock_reservations TO 'b24_app_tilda_sync'@'<SYNC_HOST_PART>';
GRANT SELECT ON b24_app.stock_reservation_lines TO 'b24_app_tilda_sync'@'<SYNC_HOST_PART>';
GRANT SELECT, INSERT, UPDATE ON b24_app.tilda_stock_sync_runs TO 'b24_app_tilda_sync'@'<SYNC_HOST_PART>';
```

The reservation grants are read-only and must be applied before deploying a
worker version that includes the reservation overlay. Verify the grants, run a
manual preview, and only then allow the scheduled cycle to publish. Missing SQL
access fails the cycle before any Tilda write.

The two-minute cron was enabled only after: pre-DDL backup, manual `0007`
migration, post-DDL backup/restore drill, grant verification, a version-pinned
manual no-op cycle and independent public parity. The first scheduler execution
returned `no_op` with `auditWritten=false`; SQL retained one manual audit row and
no `running` or `failed` rows. Public parity remained `131 parents / 150 stock
rows / 132 reversible targets / 2 unlimited exclusions / 0 differences`, with
the exact projection and content hashes recorded above. Rollback of scheduling
is to remove the cron line; the normal backend and ERP workflow are unaffected.
Do not drop the audit table as an operational rollback.
