import { APP_OWNER_USER_ID } from '@b24-app/shared';

export function canUseAdminConsole(userId: unknown): boolean {
	return String(userId ?? '') === APP_OWNER_USER_ID;
}
