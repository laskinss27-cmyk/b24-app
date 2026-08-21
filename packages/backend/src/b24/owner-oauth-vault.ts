import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import type { InstallAuthContext } from '../handlers/placement-context.js';
import { normalizeDomain } from '../security.js';
import { B24Client } from './client.js';
import { refreshAccessToken, type RefreshParams, type TokenResult } from './oauth.js';

const VAULT_VERSION = 1;
const REFRESH_EARLY_MS = 2 * 60 * 1000;

interface StoredOwnerOAuth {
	version: 1;
	domain: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	memberId: string | null;
	scope: string | null;
}

interface SealedOwnerOAuth {
	version: 1;
	algorithm: 'aes-256-gcm';
	iv: string;
	tag: string;
	ciphertext: string;
}

export interface OwnerOAuthVaultOptions {
	filePath: string;
	portalDomain: string;
	clientId: string;
	clientSecret: string;
	encryptionSecret: string;
	now?: () => number;
	refresh?: (params: RefreshParams) => Promise<TokenResult>;
}

function deriveKey(secret: string): Buffer {
	return createHash('sha256').update(`${secret}:owner-oauth-vault:v1`).digest();
}

function seal(secret: string, value: StoredOwnerOAuth): SealedOwnerOAuth {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
	cipher.setAAD(Buffer.from('b24-app:owner-oauth:v1'));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
	return {
		version: VAULT_VERSION,
		algorithm: 'aes-256-gcm',
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		ciphertext: ciphertext.toString('base64'),
	};
}

function unseal(secret: string, envelope: SealedOwnerOAuth): StoredOwnerOAuth {
	if (envelope.version !== VAULT_VERSION || envelope.algorithm !== 'aes-256-gcm') {
		throw new Error('Unsupported owner OAuth vault format');
	}
	const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(envelope.iv, 'base64'));
	decipher.setAAD(Buffer.from('b24-app:owner-oauth:v1'));
	decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
		decipher.final(),
	]);
	const value = JSON.parse(plaintext.toString('utf8')) as StoredOwnerOAuth;
	if (value.version !== VAULT_VERSION || !value.domain || !value.accessToken || !value.refreshToken || !Number.isFinite(value.expiresAt)) {
		throw new Error('Invalid owner OAuth vault payload');
	}
	return value;
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
	const directory = dirname(filePath);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		const handle = await open(tempPath, 'wx', 0o600);
		try {
			await handle.writeFile(contents, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, filePath);
		await chmod(filePath, 0o600);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

export class OwnerOAuthVault {
	private refreshInFlight: Promise<StoredOwnerOAuth> | null = null;
	private readonly now: () => number;
	private readonly refresh: (params: RefreshParams) => Promise<TokenResult>;

	constructor(private readonly options: OwnerOAuthVaultOptions) {
		this.now = options.now ?? Date.now;
		this.refresh = options.refresh ?? refreshAccessToken;
	}

	async captureInstallAuth(auth: InstallAuthContext): Promise<boolean> {
		if (!auth.refreshToken) return false;
		if (normalizeDomain(auth.domain) !== normalizeDomain(this.options.portalDomain)) {
			throw new Error('Owner OAuth domain does not match configured portal');
		}
		if (auth.scope && !auth.scope.split(/[\s,]+/u).includes('entity')) {
			throw new Error('Owner OAuth scope does not include entity');
		}
		const expiresIn = Number.isFinite(auth.expiresIn) && Number(auth.expiresIn) > 0 ? Number(auth.expiresIn) : 3600;
		await this.write({
			version: VAULT_VERSION,
			domain: normalizeDomain(auth.domain),
			accessToken: auth.accessToken,
			refreshToken: auth.refreshToken,
			expiresAt: this.now() + expiresIn * 1000,
			memberId: auth.memberId ?? null,
			scope: auth.scope ?? null,
		});
		return true;
	}

	async getClient(): Promise<B24Client> {
		const session = await this.getSession();
		return new B24Client({ auth: { kind: 'oauth', domain: session.domain, accessToken: session.accessToken } });
	}

	private async getSession(): Promise<StoredOwnerOAuth> {
		const stored = await this.read();
		if (stored.expiresAt > this.now() + REFRESH_EARLY_MS) return stored;
		if (!this.refreshInFlight) {
			this.refreshInFlight = this.rotate(stored).finally(() => { this.refreshInFlight = null; });
		}
		return this.refreshInFlight;
	}

	private async rotate(stored: StoredOwnerOAuth): Promise<StoredOwnerOAuth> {
		const token = await this.refresh({
			clientId: this.options.clientId,
			clientSecret: this.options.clientSecret,
			refreshToken: stored.refreshToken,
		});
		if (!token.accessToken || !token.refreshToken) throw new Error('Bitrix OAuth refresh did not return rotated tokens');
		const updated: StoredOwnerOAuth = {
			...stored,
			accessToken: token.accessToken,
			refreshToken: token.refreshToken,
			expiresAt: this.now() + (token.expiresIn ?? 3600) * 1000,
			memberId: token.memberId ?? stored.memberId,
			scope: token.scope ?? stored.scope,
		};
		await this.write(updated);
		return updated;
	}

	private async read(): Promise<StoredOwnerOAuth> {
		let contents: string;
		try {
			contents = await readFile(this.options.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Owner OAuth vault is not initialized');
			throw error;
		}
		return unseal(this.options.encryptionSecret, JSON.parse(contents) as SealedOwnerOAuth);
	}

	private async write(value: StoredOwnerOAuth): Promise<void> {
		await atomicWrite(this.options.filePath, `${JSON.stringify(seal(this.options.encryptionSecret, value))}\n`);
	}
}

export function createOwnerOAuthVault(config: Config, stateDirectory = process.env['B24_STATE_DIR'] ?? '/app/state'): OwnerOAuthVault | null {
	if (config.appOAuthVault !== 'on') return null;
	if (!config.appClientId || !config.appClientSecret) throw new Error('B24_APP_OAUTH_VAULT=on requires APP_CLIENT_ID and APP_CLIENT_SECRET');
	if (!config.appOperatorToken) throw new Error('B24_APP_OAUTH_VAULT=on requires B24_APP_OPERATOR_TOKEN with at least 32 characters');
	return new OwnerOAuthVault({
		filePath: join(stateDirectory, 'oauth', 'owner.v1.enc'),
		portalDomain: config.portalDomain,
		clientId: config.appClientId,
		clientSecret: config.appClientSecret,
		encryptionSecret: config.appClientSecret,
	});
}

export function isOperatorBearer(config: Config, authorization: string | undefined): boolean {
	const expected = config.appOperatorToken;
	if (!expected || !authorization?.startsWith('Bearer ')) return false;
	const actual = authorization.slice('Bearer '.length);
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
