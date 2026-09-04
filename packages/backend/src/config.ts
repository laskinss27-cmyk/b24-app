import { z } from 'zod';

/**
 * Конфиг из ENV. Валидируется один раз при старте.
 */
const ConfigSchema = z.object({
	port: z.coerce.number().int().positive().default(3000),
	host: z.string().default('0.0.0.0'),
	portalDomain: z.string().min(1).default('portal.example.bitrix24.ru'),
	/** Публичный URL нашего приложения. Используется в placement.bind как handler URL. */
	publicBaseUrl: z.string().url().default('https://app.example.com'),
	/** URL раздела «Инвентаризация» в портале — для ссылки в задаче-оповещении (заполнит Сергей). */
	appSectionUrl: z.string().default(''),
	/** Гейт оповещения: off — соисполнителей не добавляем (мьют на обкатке); on — шлём выбранным в UI. */
	inventoryNotify: z.enum(['off', 'on']).default('on'),
	appClientId: z.string().optional(),
	appClientSecret: z.string().optional(),
	appSecret: z.string().optional(),
	/** Persistent owner OAuth is opt-in; off preserves the current browser-token flow. */
	appOAuthVault: z.enum(['off', 'on']).default('off'),
	/** Separate bearer used only for server-side owner diagnostics. */
	appOperatorToken: z.string().min(32).optional(),
	autozadachiWebhook: z.string().url().optional(),
	devWebhook: z.string().url().optional(),
	/** Узкая системная запись карточки товара после Access Denied у разрешённого пользователя. */
	catalogWriteWebhook: z.string().url().optional(),
	/** Ручное owner-only сравнение актуального supply graph с SQL mirror. */
	supplyShadowCompare: z.enum(['off', 'on']).default('off'),
	/** Per-request SQL graph observation; never replaces the legacy response. */
	supplySqlRead: z.enum(['off', 'shadow', 'verified']).default('off'),
	/** Transfer-card SQL read gate; primary is allowed only with the SQL-first writer. */
	transferSqlRead: z.enum(['off', 'shadow', 'verified', 'primary']).default('off'),
	/** Manual transfer/supply request SQL read gate; primary is allowed only with the SQL-first writer. */
	transferRequestSqlRead: z.enum(['off', 'shadow', 'verified', 'primary']).default('off'),
	nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const parsed = ConfigSchema.safeParse({
		port: env['PORT'],
		host: env['HOST'],
		portalDomain: env['PORTAL_DOMAIN'],
		publicBaseUrl: env['PUBLIC_BASE_URL'],
		appSectionUrl: env['APP_SECTION_URL'],
		inventoryNotify: env['INVENTORY_NOTIFY'],
		appClientId: env['APP_CLIENT_ID'],
		appClientSecret: env['APP_CLIENT_SECRET'],
		appSecret: env['APP_SECRET'],
		appOAuthVault: env['B24_APP_OAUTH_VAULT'],
		appOperatorToken: env['B24_APP_OPERATOR_TOKEN'],
		autozadachiWebhook: env['AUTOZADACHI_WEBHOOK'],
		devWebhook: env['DEV_WEBHOOK'],
		catalogWriteWebhook: env['CATALOG_WRITE_WEBHOOK'],
		supplyShadowCompare: env['B24_APP_SUPPLY_SHADOW_COMPARE'],
		supplySqlRead: env['B24_APP_SUPPLY_SQL_READ'],
		transferSqlRead: env['B24_APP_TRANSFER_SQL_READ'],
		transferRequestSqlRead: env['B24_APP_TRANSFER_REQUEST_SQL_READ'],
		nodeEnv: env['NODE_ENV'],
	});

	if (!parsed.success) {
		console.error('Invalid ENV configuration:');
		console.error(parsed.error.format());
		throw new Error('Bad config — see ENV errors above');
	}

	return parsed.data;
}
