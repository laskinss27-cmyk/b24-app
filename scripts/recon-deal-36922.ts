import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l: string, d: unknown) { let s = JSON.stringify(d, null, 1); if (s && s.length > 6000) s = s.slice(0, 6000) + '…'; console.log(l + ': ' + s); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> { try { return await client.call<T>(m, p); } catch (e) { console.log('  ⛔ ' + m + ' → ' + (e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e))); return null; } }
const DID = 36922;
(async () => {
  console.log('======== СДЕЛКА', DID, '========');
  const deal = await tc<Record<string, unknown>>('crm.deal.get', { id: DID });
  if (deal) {
    const keys = ['ID', 'TITLE', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'CATEGORY_ID', 'OPPORTUNITY', 'IS_MANUAL_OPPORTUNITY', 'CONTACT_ID', 'COMPANY_ID', 'CLOSED', 'CLOSEDATE'];
    for (const k of keys) console.log('  ' + k + ' =', deal[k]);
    // поля «Кассы»
    console.log('  KASSA оплачено (UF_CRM_1765984372) =', deal['UF_CRM_1765984372']);
    console.log('  KASSA остаток  (UF_CRM_1765984397) =', deal['UF_CRM_1765984397']);
  }

  console.log('\n======== ТОВАРНЫЕ СТРОКИ (productrows.get) ========');
  const rows = await tc<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: DID }) ?? [];
  let rowsSum = 0;
  for (const r of rows) {
    const line = Number(r['PRICE'] ?? 0) * Number(r['QUANTITY'] ?? 0);
    rowsSum += line;
    console.log(`  ID=${r['ID']} TYPE=${r['TYPE']} PRODUCT_ID=${r['PRODUCT_ID']} "${String(r['PRODUCT_NAME']).slice(0, 40)}" qty=${r['QUANTITY']} price=${r['PRICE']} disc=${r['DISCOUNT_SUM']} STORE_ID=${r['STORE_ID']} → ${line}`);
  }
  console.log('  Σ строк =', rowsSum, '| строк:', rows.length);

  console.log('\n======== НОВЫЕ СТРОКИ (crm.item.productrow.list ownerType=D) ========');
  const pr = await tc<{ productRows?: Array<Record<string, unknown>> }>('crm.item.productrow.list', { filter: { ownerType: 'D', ownerId: DID }, select: ['*'] });
  for (const r of pr?.productRows ?? []) console.log(`  id=${r['id']} productId=${r['productId']} "${String(r['productName']).slice(0, 40)}" qty=${r['quantity']} price=${r['price']} storeId=${r['storeId']}`);

  console.log('\n======== ЗАКАЗ (orderentity) ========');
  const bnd = await tc<{ orderEntity?: Array<Record<string, unknown>> }>('crm.orderentity.list', { filter: { ownerId: DID, ownerTypeId: 2 }, select: ['*'] });
  j('orderEntity', bnd?.orderEntity);
  const orderId = Number(bnd?.orderEntity?.[0]?.['orderId'] ?? 0);
  if (orderId) {
    console.log('\n-- заказ', orderId, '--');
    j('order', await tc('sale.order.get', { id: orderId }));
    console.log('\n-- корзина заказа --');
    j('basket', await tc('sale.basketitem.list', { filter: { orderId }, select: ['id', 'productId', 'name', 'quantity', 'price', 'type', 'xmlId'] }));
    console.log('\n-- отгрузки заказа --');
    j('shipments', await tc('sale.shipment.list', { filter: { orderId }, select: ['id', 'orderId', 'accountNumber', 'deducted', 'allowDelivery', 'deliveryId', 'statusId'] }));
  } else {
    console.log('  заказа у сделки НЕТ');
  }

  console.log('\n======== ОСТАТКИ В Б24-СКЛАДЕ по товарам сделки ========');
  const ids = [...new Set(rows.filter((r) => Number(r['TYPE']) !== 7 && Number(r['PRODUCT_ID']) > 0).map((r) => Number(r['PRODUCT_ID'])))];
  for (const id of ids) {
    j('product ' + id, await tc('catalog.storeproduct.list', { filter: { productId: id }, select: ['storeId', 'amount', 'quantityReserved'] }));
  }
})().catch((e) => console.error('FATAL', e));
