/** Read-only: сколько товаров Б24 имеют картинку (detailPicture/previewPicture). */
import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
(async () => {
	let withPic = 0, total = 0;
	for (const iblockId of [24, 26]) {
		let start: number | undefined = 0;
		while (start !== undefined) {
			const r = await c.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
				filter: { iblockId }, select: ['id', 'iblockId', 'detailPicture', 'previewPicture'], order: { id: 'ASC' }, start,
			});
			const rows = r?.products ?? [];
			for (const p of rows) { total++; if (p['detailPicture'] || p['previewPicture']) withPic++; }
			start = rows.length === 50 ? start + 50 : undefined;
		}
	}
	console.log(`всего: ${total} | с картинкой: ${withPic}`);
})().catch((e) => console.error('FATAL', e));
