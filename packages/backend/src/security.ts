import type { Config } from './config.js';
import type { PlacementBody, PlacementQuery } from './handlers/placement-context.js';

/**
 * Проверка подлинности входящих запросов от Б24.
 *
 * Б24 не даёт крипто-подписи placement-запросов, которую можно проверить без
 * заранее сохранённого секрета, поэтому защищаемся многослойно и консервативно:
 *
 *   1. domain allowlist — DOMAIN из запроса обязан совпасть с нашим порталом.
 *      Это главный гейт: закрывает SSRF (client.ts строит REST-URL из domain)
 *      и отсекает запросы с чужих/поддельных порталов.
 *   2. application_token — если APP_SECRET задан в env И токен пришёл в теле,
 *      они обязаны совпасть. Жёстко требовать токен нельзя (не все запросы Б24
 *      его несут — сломаем легитимный flow), поэтому это доп-слой, не основной.
 *
 * Почему этого достаточно для Sprint 1: даже если злоумышленник подставит DOMAIN
 * нашего портала, без валидного OAuth-токена ни один вызов в Б24 не пройдёт
 * (Битрикс отвергнет токен), а SSRF уже закрыт пунктом 1. HTML-роут
 * (/placement/deal-tab) токеном не пользуется — там защита это allowlist + экранирование.
 */

export type VerifyVerdict = { ok: true } | { ok: false; reason: string };

export function normalizeDomain(domain: string): string {
	return domain
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '');
}

export function verifyBitrixRequest(
	body: PlacementBody,
	query: PlacementQuery,
	config: Pick<Config, 'portalDomain' | 'appSecret'>,
): VerifyVerdict {
	const rawDomain = body.DOMAIN ?? query.DOMAIN;
	if (!rawDomain) return { ok: false, reason: 'no-domain' };
	if (normalizeDomain(rawDomain) !== normalizeDomain(config.portalDomain)) {
		return { ok: false, reason: 'domain-mismatch' };
	}
	if (config.appSecret && body.APPLICATION_TOKEN && body.APPLICATION_TOKEN !== config.appSecret) {
		return { ok: false, reason: 'app-token-mismatch' };
	}
	return { ok: true };
}
