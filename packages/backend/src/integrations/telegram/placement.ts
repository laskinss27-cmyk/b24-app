import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema, PlacementQuerySchema, buildPlacementContext } from '../../handlers/placement-context.js';
import { verifyBitrixRequest } from '../../security.js';
import { B24ApiError, type B24Client } from '../../b24/client.js';
export async function bindTelegramPlacement(client: B24Client, base: string): Promise<void> {

    const handler=`${base.replace(/\/$/, '')}/placement/telegram`;
    const rows=await client.call<{PLACEMENT:string;HANDLER:string;TITLE?:string}[]>('placement.get');
    if(!Array.isArray(rows))throw new Error('Invalid placement list');
    const previous=rows.find(row=>row.PLACEMENT==='CRM_DEAL_DETAIL_TAB' && row.HANDLER===handler);
    if(previous?.TITLE==='Сообщения')return;
    if(previous)await client.call('placement.unbind',{PLACEMENT:'CRM_DEAL_DETAIL_TAB',HANDLER:handler});
    try { await client.call('placement.bind',{PLACEMENT:'CRM_DEAL_DETAIL_TAB',HANDLER:handler,TITLE:'Сообщения',LANG_ALL:{ru:{TITLE:'Сообщения'},en:{TITLE:'Messages'}}}); }
    catch(error){
        // Restore only our exact previous handler if renaming fails. Never unbind other app tabs.
        if(previous){try{await client.call('placement.bind',{PLACEMENT:'CRM_DEAL_DETAIL_TAB',HANDLER:handler,TITLE:previous.TITLE||'Переписка'});}catch{/* Report registration failure to caller. */}}
        if(!previous && error instanceof B24ApiError && /already.*bind|ALREADY_BINDED/i.test(`${error.code} ${error.description}`))return;
        throw error;
    }
}

export function registerTelegramPlacement(app: FastifyInstance): void {
    app.post('/placement/telegram', async (req, reply) => {
        const body = PlacementBodySchema.safeParse(req.body), query = PlacementQuerySchema.safeParse(req.query);
        if (!body.success || !verifyBitrixRequest(body.data, query.success ? query.data : {}, app.config).ok)
            return reply.code(403).send('forbidden');
        const ctx = { ...buildPlacementContext(body.data), view: 'telegram' };
        if (!ctx.dealId)
            return reply.code(400).send('deal required');
        const html = await app.readFrontendIndex();
        if (!html)
            return reply.code(503).send('Frontend is not built');
        const json = JSON.stringify(ctx).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
        return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(html.replace('</head>', `<script src="https://api.bitrix24.com/api/v1/"></script><script>window.__B24_CONTEXT__=${json};</script></head>`));
    });
}
