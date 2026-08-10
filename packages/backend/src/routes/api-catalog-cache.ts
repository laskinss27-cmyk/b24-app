import { normalizeDomain } from '../security.js';
import type { CacheEntry } from './api-catalog-types.js';

export const CACHE_TTL_MS = 5 * 60 * 1000;
export const baseCache = new Map<string, CacheEntry>();

export function invalidateCatalogCache(domain: string): void {
	baseCache.delete(normalizeDomain(domain));
}
