import type { FastifyInstance } from 'fastify';
import { canCopyCatalogProduct, type CatalogAccessUser } from '../catalog-access.js';
import { ErpClient } from '../erp/client.js';
import { MARKETPLACE_BUNDLE_SOURCE_FIELD as SOURCE, MARKETPLACE_BUNDLE_UNITS_FIELD as UNITS } from '../erp/marketplace-fields.js';
import { catalogClientFrom, errInfo } from './api-catalog-route-helpers.js';
import type { AuthBody } from './api-catalog-types.js';
export interface CopyBundle { sourceProductId: number; units: number }
export async function readCopySource(erp: ErpClient, id: unknown) {
 const productId = Number(id);
 if (!Number.isSafeInteger(productId) || productId <= 0) throw Error('Неверный исходный товар');
 const item = await erp.get<Record<string, unknown>>('Item', String(productId));
 if (!item || Number(item.disabled)) throw Error('Исходная карточка недоступна');
 const source = Number(item[SOURCE]);
 const units = Number(item[UNITS]);
 if (item[SOURCE] && (!Number.isSafeInteger(source) || source <= 0 || !Number.isSafeInteger(units) || units < 2)) throw Error('Проверь состав исходного комплекта');
 return { isService: Number(item.is_stock_item) === 0, bundle: source > 0 ? { sourceProductId: source, units } : null };
}
export async function validateCopyBundle(erp: ErpClient, original: CopyBundle | null, value: unknown): Promise<Record<string, unknown>> {
 if (!original) { if (value != null) throw Error('Исходная карточка не является комплектом'); return {}; }
 if (!value || typeof value !== 'object') throw Error('Укажи состав комплекта');
 const input = value as Record<string, unknown>, id = Number(input.sourceProductId), units = Number(input.units);
 if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(units) || units < 2) throw Error('В комплекте должно быть не меньше двух единиц товара');
 const item = await erp.get<Record<string, unknown>>('Item', String(id));
 if (!item || Number(item.disabled) || Number(item.is_stock_item) !== 1 || item[SOURCE]) throw Error('Выбери действующий обычный товар для комплекта');
 return { [SOURCE]: String(id), [UNITS]: units };
}
export function registerCatalogCopyDetailsRoute(app: FastifyInstance): void {
 app.post('/api/catalog/copy-details', async (req, reply) => {
  const body = (req.body ?? {}) as AuthBody & { productId?: unknown };
  const client = catalogClientFrom(app, body);
  if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
  const user = await client.call<CatalogAccessUser>('user.current', {}).catch(() => null);
  if (!canCopyCatalogProduct(user)) return reply.code(403).send({ ok: false, error: 'Нет права копировать карточки товаров' });
  const erp = ErpClient.fromEnv();
  if (!erp) return reply.code(503).send({ ok: false, error: 'Ядро недоступно' });
  try { return { ok: true, ...await readCopySource(erp, body.productId) }; }
  catch (error) { return reply.code(400).send({ ok: false, error: errInfo(error) }); }
 });
}
