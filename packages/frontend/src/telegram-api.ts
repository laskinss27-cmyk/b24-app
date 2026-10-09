import { bx24Auth } from './bitrix-auth.js';
export type TelegramApi = <T>(action: string, body?: Record<string, unknown>) => Promise<T>;
export const messengerApi = (messenger: 'telegram'|'whatsapp'): TelegramApi => async <T,>(action: string, body: Record<string, unknown> = {}): Promise<T> => {
    if (window.BX24)
        await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Битрикс24 не ответил. Обновите вкладку')), 8000); window.BX24!.init(() => { clearTimeout(timeout); resolve(); }); });
    const sdkAuth = (action === 'connect' || action === 'auto-binding' && body.enabled === true) ? window.BX24?.getAuth() : false;
    const refresh = sdkAuth && sdkAuth.refresh_token ? { refreshToken: sdkAuth.refresh_token } : {};
    const response = await fetch(`/api/${messenger}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...refresh, ...bx24Auth() }), signal: AbortSignal.timeout(30000) });
    const result = await response.json() as {
        ok?: boolean;
        error?: string;
    };
    if (!response.ok || !result.ok)
        throw Object.assign(new Error(result.error || 'Не удалось выполнить запрос'), { status: response.status });
    return result as T;
};

export const telegramApi=messengerApi('telegram');
export const whatsappApi=messengerApi('whatsapp');
