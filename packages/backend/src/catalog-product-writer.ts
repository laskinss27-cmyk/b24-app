import { B24ApiError, type B24Client } from './b24/client.js';

export interface CatalogProductWriteResult<T> {
	result: T;
	client: B24Client;
	delegated: boolean;
}

export function isCatalogProductAccessDenied(error: unknown): boolean {
	if (!(error instanceof B24ApiError)) return false;
	const details = `${error.code} ${error.description ?? ''}`;
	return error.code === '200040300040' || /access\s*denied/i.test(details);
}

export async function addCatalogProductWithAccessFallback<T>(args: {
	userClient: B24Client;
	systemClient: B24Client | null;
	fields: Record<string, unknown>;
}): Promise<CatalogProductWriteResult<T>> {
	try {
		return {
			result: await args.userClient.call<T>('catalog.product.add', { fields: args.fields }),
			client: args.userClient,
			delegated: false,
		};
	} catch (error) {
		if (!args.systemClient || !isCatalogProductAccessDenied(error)) throw error;
		return {
			result: await args.systemClient.call<T>('catalog.product.add', { fields: args.fields }),
			client: args.systemClient,
			delegated: true,
		};
	}
}
