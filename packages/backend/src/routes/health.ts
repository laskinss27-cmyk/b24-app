import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';

export function readReleaseInfo(path: URL = new URL('../../../../release.json', import.meta.url)): {
	gitSha: string | null; gitTree: string | null; builtAt: string | null;
} {
	try {
		const release = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		if (typeof release['gitSha'] !== 'string' || !/^[a-f0-9]{40}$/.test(release['gitSha'])
			|| typeof release['gitTree'] !== 'string' || !/^[a-f0-9]{40}$/.test(release['gitTree'])
			|| typeof release['builtAt'] !== 'string' || !Number.isFinite(Date.parse(release['builtAt']))) {
			throw new Error('Invalid release.json');
		}
		return { gitSha: release['gitSha'], gitTree: release['gitTree'], builtAt: release['builtAt'] };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		return { gitSha: null, gitTree: null, builtAt: null };
	}
}

/**
 * GET /health — проверка, что приложение поднялось и прочитало конфигурацию.
 */
export function registerHealthRoute(app: FastifyInstance): void {
	// Read the baked-in file, not inherited container environment from the previous release.
	const release = readReleaseInfo();
	app.get('/health', async () => {
		return {
			ok: true,
			version: '0.0.1',
			...release,
			portalDomain: app.config.portalDomain,
			nodeEnv: app.config.nodeEnv,
			timestamp: new Date().toISOString(),
		};
	});
}
