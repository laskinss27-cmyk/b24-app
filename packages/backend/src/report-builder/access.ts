import type { B24Client } from '../b24/client.js';

export interface ReportBuilderUser {
	id: string;
	name: string;
	isAdmin: boolean;
}

export async function reportBuilderUser(client: B24Client): Promise<ReportBuilderUser | null> {
	const user = await client.call<{
		ID?: string | number;
		NAME?: string;
		LAST_NAME?: string;
		ADMIN?: boolean | string;
	}>('user.current', {}).catch(() => null);
	const id = String(user?.ID ?? '');
	if (!/^\d{1,12}$/.test(id)) return null;
	const isAdmin = user?.ADMIN === true || String(user?.ADMIN ?? '').toUpperCase() === 'Y';
	if (!isAdmin && id !== '1') return null;
	return {
		id,
		name: `${user?.LAST_NAME ?? ''} ${user?.NAME ?? ''}`.trim() || `#${id}`,
		isAdmin,
	};
}
