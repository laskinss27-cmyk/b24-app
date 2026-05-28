import { z } from 'zod';

/**
 * Конфиг из ENV. Валидируется один раз при старте.
 */
const ConfigSchema = z.object({
	port: z.coerce.number().int().positive().default(3000),
	host: z.string().default('0.0.0.0'),
	portalDomain: z.string().min(1).default('umniydom.bitrix24.ru'),
	appClientId: z.string().optional(),
	appClientSecret: z.string().optional(),
	appSecret: z.string().optional(),
	autozadachiWebhook: z.string().url().optional(),
	devWebhook: z.string().url().optional(),
	nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
	const parsed = ConfigSchema.safeParse({
		port: process.env['PORT'],
		host: process.env['HOST'],
		portalDomain: process.env['PORTAL_DOMAIN'],
		appClientId: process.env['APP_CLIENT_ID'],
		appClientSecret: process.env['APP_CLIENT_SECRET'],
		appSecret: process.env['APP_SECRET'],
		autozadachiWebhook: process.env['AUTOZADACHI_WEBHOOK'],
		devWebhook: process.env['DEV_WEBHOOK'],
		nodeEnv: process.env['NODE_ENV'],
	});

	if (!parsed.success) {
		console.error('Invalid ENV configuration:');
		console.error(parsed.error.format());
		throw new Error('Bad config — see ENV errors above');
	}

	return parsed.data;
}
