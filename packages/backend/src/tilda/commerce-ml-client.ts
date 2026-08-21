export interface TildaCommerceMlConfig {
	url: string;
	username: string;
	password: string;
}

export interface TildaCommerceMlSession {
	cookie: string;
	fileLimit: number;
}

export interface TildaCommerceMlImportResult {
	fileName: string;
	importResponses: string[];
}

export interface TildaCommerceMlExchangeResult {
	catalog: TildaCommerceMlImportResult;
	offers: TildaCommerceMlImportResult;
}

function connectorUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.hostname !== 'store.tilda.ru' || url.username || url.password) {
		throw new Error('Tilda CommerceML connector must be an authenticated HTTPS store.tilda.ru URL');
	}
	return url;
}

function responseLines(value: string): string[] {
	return value.replaceAll('\r', '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function protocolFailureDetail(lines: string[]): string {
	const detail = lines.slice(0, 4).join(' | ')
		.replaceAll(/https?:\/\/\S+/giu, '[url]')
		.replaceAll(/(?:authorization|cookie|password|пароль)\s*[:=]\s*\S+/giu, '[redacted]')
		.replaceAll(/[\x00-\x1f\x7f]/gu, ' ')
		.trim()
		.slice(0, 300);
	return detail || 'empty response';
}

function safeCookie(name: string, value: string): string {
	if (!/^[A-Za-z0-9_-]+$/u.test(name) || !/^[^;\s\x00-\x1f\x7f]+$/u.test(value)) {
		throw new Error('Tilda CommerceML returned an invalid session cookie');
	}
	return `${name}=${value}`;
}

function safeFileName(value: string): string {
	if (!/^(?:import|offers)[A-Za-z0-9_.-]*\.xml$/u.test(value)) throw new Error('Tilda CommerceML filename is invalid');
	return value;
}

export class TildaCommerceMlClient {
	readonly #baseUrl: URL;
	readonly #authorization: string;
	readonly #fetch: typeof fetch;

	constructor(config: TildaCommerceMlConfig, fetcher: typeof fetch = fetch) {
		this.#baseUrl = connectorUrl(config.url);
		if (!config.username || !config.password) throw new Error('Tilda CommerceML credentials are incomplete');
		this.#authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
		this.#fetch = fetcher;
	}

	async #request(
		mode: 'checkauth' | 'init' | 'file' | 'import',
		options: { cookie?: string; fileName?: string; body?: BodyInit } = {},
	): Promise<string> {
		const url = new URL(this.#baseUrl);
		url.searchParams.set('type', 'catalog');
		url.searchParams.set('mode', mode);
		if (options.fileName) url.searchParams.set('filename', safeFileName(options.fileName));
		const headers = new Headers();
		if (mode === 'checkauth') headers.set('Authorization', this.#authorization);
		if (options.cookie) headers.set('Cookie', options.cookie);
		if (options.body !== undefined) headers.set('Content-Type', 'application/octet-stream');
		const request: RequestInit = {
			method: options.body === undefined ? 'GET' : 'POST',
			headers,
			redirect: 'error',
			signal: AbortSignal.timeout(30_000),
		};
		if (options.body !== undefined) request.body = options.body;
		const response = await this.#fetch(url, request);
		if (!response.ok) throw new Error(`Tilda CommerceML ${mode} returned HTTP ${response.status}`);
		return response.text();
	}

	async authenticateAndInitialize(): Promise<TildaCommerceMlSession> {
		const authLines = responseLines(await this.#request('checkauth'));
		if (authLines[0] !== 'success' || authLines.length < 3) throw new Error('Tilda CommerceML authentication failed');
		const cookie = safeCookie(authLines[1] ?? '', authLines[2] ?? '');
		const initLines = responseLines(await this.#request('init', { cookie }));
		const init = new Map(initLines.map((line) => {
			const separator = line.indexOf('=');
			return separator < 1 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
		}));
		if (init.get('zip') !== 'no') throw new Error('Tilda CommerceML ZIP exchange is not supported');
		const fileLimit = Number(init.get('file_limit'));
		if (!Number.isInteger(fileLimit) || fileLimit <= 0) throw new Error('Tilda CommerceML file limit is invalid');
		return { cookie, fileLimit };
	}

	async uploadAndImportOffers(
		session: TildaCommerceMlSession,
		xml: string,
		fileName = 'offers0_1.xml',
	): Promise<TildaCommerceMlImportResult> {
		const checkedFileName = safeFileName(fileName);
		if (!checkedFileName.startsWith('offers')) throw new Error('Tilda CommerceML offers filename is invalid');
		const bytes = Buffer.byteLength(xml, 'utf8');
		if (bytes === 0 || bytes > session.fileLimit) throw new Error(`Tilda CommerceML offers file exceeds the ${session.fileLimit} byte limit`);
		const fileLines = responseLines(await this.#request('file', {
			cookie: session.cookie,
			fileName: checkedFileName,
			body: Buffer.from(xml, 'utf8'),
		}));
		if (fileLines[0] !== 'success') throw new Error(`Tilda CommerceML offers upload failed: ${protocolFailureDetail(fileLines)}`);

		const importResponses: string[] = [];
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const lines = responseLines(await this.#request('import', { cookie: session.cookie, fileName: checkedFileName }));
			const status = lines[0] ?? '';
			importResponses.push(status);
			if (status === 'success') return { fileName: checkedFileName, importResponses };
			if (status !== 'progress') throw new Error(`Tilda CommerceML offers import failed: ${protocolFailureDetail(lines)}`);
		}
		throw new Error('Tilda CommerceML offers import did not finish within 20 requests');
	}

	async uploadAndImportStock(
		session: TildaCommerceMlSession,
		catalogXml: string,
		offersXml: string,
	): Promise<TildaCommerceMlExchangeResult> {
		const upload = async (xml: string, fileName: string): Promise<void> => {
			const bytes = Buffer.byteLength(xml, 'utf8');
			if (bytes === 0 || bytes > session.fileLimit) throw new Error(`Tilda CommerceML file exceeds the ${session.fileLimit} byte limit`);
			const lines = responseLines(await this.#request('file', {
				cookie: session.cookie,
				fileName,
				body: Buffer.from(xml, 'utf8'),
			}));
			if (lines[0] !== 'success') throw new Error(`Tilda CommerceML file upload failed: ${protocolFailureDetail(lines)}`);
		};
		const runImport = async (fileName: string): Promise<TildaCommerceMlImportResult> => {
			const importResponses: string[] = [];
			for (let attempt = 0; attempt < 20; attempt += 1) {
				const lines = responseLines(await this.#request('import', { cookie: session.cookie, fileName }));
				const status = lines[0] ?? '';
				importResponses.push(status);
				if (status === 'success') return { fileName, importResponses };
				if (status !== 'progress') throw new Error(`Tilda CommerceML ${fileName} import failed: ${protocolFailureDetail(lines)}`);
			}
			throw new Error(`Tilda CommerceML ${fileName} import did not finish within 20 requests`);
		};

		await upload(catalogXml, 'import0_1.xml');
		await upload(offersXml, 'offers0_1.xml');
		const catalog = await runImport('import0_1.xml');
		const offers = await runImport('offers0_1.xml');
		return { catalog, offers };
	}
}
