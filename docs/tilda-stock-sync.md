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
  for `confirmed` ERP Items, excludes `Goods In Transit` and `Склад Прихода`,
  verifies that every confirmed Item is active, distinguishes an active
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
version-pinned `b24-app:faffa98` image.

## Guarded reconciliation worker

The repository contains a one-cycle worker that remains disabled unless
`TILDA_STOCK_SYNC=on` is explicitly passed. The normal backend never calls it at
startup or through HTTP. Production activation is isolated in a versioned host
wrapper and one cron line; removing that line stops scheduling without changing
backend or ERPNext behavior.

Each cycle holds both a host `flock` and connection-scoped MariaDB `GET_LOCK`,
then reads 150 SQL stock mappings, all 134 confirmed ERP Items through the
official API and the complete public Tilda catalog. It requires the audited
shape `150 mappings / 134 projected / 16 skipped / 131 parents / 150 stock
rows / 132 reversible / 2 exact unlimited exclusions`. Any missing Item,
changed UID/SKU, incomplete page, unresolved shape or read error fails closed.
It never turns a failed read into zeros.

If all 132 reversible quantities already match, the worker makes no Tilda
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
GRANT SELECT, INSERT, UPDATE ON b24_app.tilda_stock_sync_runs TO 'b24_app_tilda_sync'@'<SYNC_HOST_PART>';
```

The two-minute cron was enabled only after: pre-DDL backup, manual `0007`
migration, post-DDL backup/restore drill, grant verification, a version-pinned
manual no-op cycle and independent public parity. The first scheduler execution
returned `no_op` with `auditWritten=false`; SQL retained one manual audit row and
no `running` or `failed` rows. Public parity remained `131 parents / 150 stock
rows / 132 reversible targets / 2 unlimited exclusions / 0 differences`, with
the exact projection and content hashes recorded above. Rollback of scheduling
is to remove the cron line; the normal backend and ERP workflow are unaffected.
Do not drop the audit table as an operational rollback.
