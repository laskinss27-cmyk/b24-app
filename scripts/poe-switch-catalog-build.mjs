import fs from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith('--') || value == null) throw new Error('Arguments must use --name value');
	args.set(key.slice(2), value);
}

const scopePath = path.resolve(args.get('scope') ?? 'work-catalog-poe-switches/scope.json');
const outputPath = path.resolve(args.get('output') ?? 'work-catalog-poe-switches/final-poe-switch-catalog.json');
const scope = JSON.parse(await fs.readFile(scopePath, 'utf8'));

const groups = {
	main: 'Основное',
	ports: 'Порты и подключение',
	poe: 'Питание PoE',
	network: 'Сетевые функции',
	power: 'Электропитание',
	protection: 'Защита',
	installation: 'Монтаж и корпус',
	operation: 'Эксплуатация',
};

const spec = (key, label, group, type, rawValue, {
	unit = '',
	filterable = true,
	booleanValue = null,
	numberValue = null,
} = {}) => ({
	key,
	label,
	sourceLabel: label,
	group,
	type,
	rawValue: String(rawValue),
	normalizedValue: type === 'number' && numberValue != null ? String(numberValue) : String(rawValue),
	numberValue: type === 'number' ? numberValue : null,
	numberMin: null,
	numberMax: null,
	unit,
	booleanValue: type === 'boolean' ? booleanValue : null,
	filterable,
});

const n = (key, label, group, value, unit = '', filterable = true) => (
	spec(key, label, group, 'number', unit ? `${value} ${unit}` : value, {
		unit,
		filterable,
		numberValue: Number(value),
	})
);
const o = (key, label, group, value, filterable = true) => spec(key, label, group, 'option', value, { filterable });
const t = (key, label, group, value, filterable = false) => spec(key, label, group, 'text', value, { filterable });
const b = (key, label, group, value, filterable = true) => spec(
	key,
	label,
	group,
	'boolean',
	value ? 'Да' : 'Нет',
	{ filterable, booleanValue: value },
);
const r = (key, label, group, min, max, unit = '', filterable = true) => ({
	key,
	label,
	sourceLabel: label,
	group,
	type: 'range',
	rawValue: `${min}–${max}${unit ? ` ${unit}` : ''}`,
	normalizedValue: `${min}…${max}`,
	numberValue: null,
	numberMin: Number(min),
	numberMax: Number(max),
	unit,
	booleanValue: null,
	filterable,
});

const common = {
	unmanaged: [
		o('device_type', 'Тип устройства', groups.main, 'PoE-коммутатор'),
		o('management_type', 'Управление', groups.main, 'Неуправляемый'),
		o('connection', 'Подключение', groups.ports, 'Ethernet / PoE'),
	],
	managed: [
		o('device_type', 'Тип устройства', groups.main, 'PoE-коммутатор'),
		o('management_type', 'Управление', groups.main, 'Управляемый'),
		o('connection', 'Подключение', groups.ports, 'Ethernet / PoE'),
	],
};

const redlineFunctions = (distance = 250) => [
	b('poe_watchdog', 'PoE Watchdog', groups.network, true),
	b('port_isolation', 'Изоляция PoE-портов', groups.network, true),
	n('extend_distance', 'Дальность в режиме Extend', groups.network, distance, 'м'),
];

const profiles = new Map([
	[14096, {
		model: 'RL-SW4P2.SE',
		summary: 'Компактный неуправляемый PoE-коммутатор Redline с четырьмя портами PoE+ и двумя uplink-портами. Версия SE рассчитана на удобный монтаж и поддерживает Watchdog, изоляцию портов и режим передачи до 250 м.',
		sources: [
			'https://redline-cctv.ru/catalog/video_observation/activenetwork/switchaccess/',
			'https://www.telecamera.ru/catalog/Videonablyudenie/IP_videonablyudenie/Setevoe_oborudovanie/PoE/Kommutatory/REDLINE/RL_SW4P2.SE.htm',
		],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 6),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 4),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '2 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 60, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			...redlineFunctions(),
			t('power_supply', 'Питание', groups.power, 'DC 52 В, блок питания в комплекте'),
			t('mounting', 'Монтаж', groups.installation, 'DIN-рейка / стена / плоскость', true),
			t('dimensions', 'Габариты', groups.installation, '125 × 75 × 27 мм'),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от −10 до +50 °C'),
		],
	}],
	[11606, {
		model: 'FX-POE4.2',
		summary: 'Неуправляемый шестипортовый коммутатор FOX для небольшой системы видеонаблюдения: четыре порта PoE+ и два uplink-порта. Поддерживает бюджет 60 Вт и режим увеличенной дальности до 250 м.',
		sources: ['https://videooko.ru/videonablyudenie/ip-videonablyudenie/kommutatory-poe/fox-fx-poe4-2/'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 6),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 4),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '2 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 60, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			n('extend_distance', 'Дальность в режиме Extend', groups.network, 250, 'м'),
			n('switching_capacity', 'Коммутационная способность', groups.network, 1.6, 'Гбит/с'),
			t('mac_table', 'Таблица MAC-адресов', groups.network, '1K'),
			t('power_supply', 'Питание', groups.power, '220 В AC, встроенный блок питания'),
			t('dimensions', 'Габариты', groups.installation, '149 × 93 × 28 мм'),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от −20 до +55 °C'),
		],
	}],
	[11018, {
		model: 'PoE+ Switch 5 KN-4610',
		summary: 'Неуправляемый гигабитный коммутатор Keenetic с четырьмя портами PoE+ и одним обычным Ethernet-портом. Общий бюджет PoE — 60 Вт, до 30 Вт на один порт.',
		sources: ['https://keenetic.com/en/keenetic-poe-plus-switch-5'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 5),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 4),
			n('poe_port_speed', 'Скорость Ethernet-портов', groups.ports, 1000, 'Мбит/с'),
			t('uplink_ports', 'Порт без PoE', groups.ports, '1 × RJ45 1 Гбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 60, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			n('switching_capacity', 'Коммутационная способность', groups.network, 10, 'Гбит/с'),
			t('mac_table', 'Таблица MAC-адресов', groups.network, '2K'),
			t('jumbo_frame', 'Jumbo Frame', groups.network, 'до 15 КБ'),
			o('qos', 'Приоритизация трафика', groups.network, 'DSCP / IEEE 802.1p'),
			t('power_supply', 'Питание', groups.power, '100–240 В AC; адаптер 55 В / 1,3 А'),
			t('mounting', 'Монтаж', groups.installation, 'настольный или настенный', true),
			t('dimensions', 'Габариты', groups.installation, '100 × 100 × 26 мм'),
			n('weight', 'Масса', groups.installation, 205, 'г', false),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от 0 до +40 °C'),
		],
	}],
	[14580, {
		model: 'RL-SW8P2',
		summary: 'Неуправляемый PoE-коммутатор Redline для подключения до восьми устройств и двух uplink-линий. Поддерживает PoE+, Watchdog, изоляцию портов, QoS и передачу до 250 м.',
		sources: ['https://redline-cctv.ru/catalog/video_observation/activenetwork/switchaccess/rl-sw8p2/'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 10),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 8),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '2 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 96, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			...redlineFunctions(),
			b('qos', 'Аппаратный QoS', groups.network, true),
			t('power_supply', 'Питание', groups.power, 'внешний блок питания'),
			t('mounting', 'Монтаж', groups.installation, 'стена / DIN-рейка / плоскость', true),
			t('dimensions', 'Габариты', groups.installation, '184 × 94 × 27 мм'),
		],
	}],
	[18100, {
		model: 'TC-P3S06 Spec:F/0420/AT/55',
		summary: 'Неуправляемый коммутатор Tiandy с четырьмя PoE-портами Fast Ethernet и двумя uplink-портами. Поддерживает бюджет 55 Вт, PoE Watchdog, приоритет портов, VLAN и режим Extend до 220 м.',
		sources: ['https://www.tiandy.ps/writable/uploads/products/1756189475_b8ca56187cf7b2db0252.pdf'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 6),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 4),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '2 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 55, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			b('poe_watchdog', 'PoE Watchdog', groups.network, true),
			b('port_isolation', 'Изоляция PoE-портов', groups.network, true),
			b('poe_priority', 'Приоритет PoE-портов', groups.network, true),
			n('extend_distance', 'Дальность в режиме Extend', groups.network, 220, 'м'),
			n('switching_capacity', 'Коммутационная способность', groups.network, 1.2, 'Гбит/с'),
			t('mac_table', 'Таблица MAC-адресов', groups.network, '1K'),
			t('power_supply', 'Питание', groups.power, '100–240 В AC; 52 В / 1,25 А'),
			n('surge_protection', 'Грозозащита портов', groups.protection, 4, 'кВ'),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от −10 до +50 °C'),
		],
	}],
	[11020, {
		model: 'PoE+ Switch 9 KN-4710',
		summary: 'Неуправляемый гигабитный коммутатор Keenetic с восемью портами PoE+ и одним обычным Ethernet-портом. Общий бюджет питания — 120 Вт, до 30 Вт на порт.',
		sources: ['https://help.keenetic.com/hc/article_attachments/14633941578396'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 9),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 8),
			n('poe_port_speed', 'Скорость Ethernet-портов', groups.ports, 1000, 'Мбит/с'),
			t('uplink_ports', 'Порт без PoE', groups.ports, '1 × RJ45 1 Гбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 120, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			n('switching_capacity', 'Коммутационная способность', groups.network, 18, 'Гбит/с'),
			t('mac_table', 'Таблица MAC-адресов', groups.network, '2K'),
			t('jumbo_frame', 'Jumbo Frame', groups.network, 'до 15 КБ'),
			o('qos', 'Приоритизация трафика', groups.network, 'DSCP / IEEE 802.1p'),
			t('power_supply', 'Питание', groups.power, '100–240 В AC; адаптер 55 В / 2,55 А'),
			t('mounting', 'Монтаж', groups.installation, 'настольный или настенный', true),
			t('dimensions', 'Габариты', groups.installation, '177 × 105 × 26 мм'),
			n('weight', 'Масса', groups.installation, 427, 'г', false),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от 0 до +40 °C'),
		],
	}],
	[18096, {
		model: 'TC-P3S010 F/0820/AT/90',
		summary: 'Неуправляемый коммутатор Tiandy с восемью PoE-портами и двумя uplink-портами Fast Ethernet. Поддерживает бюджет 90 Вт, Watchdog, VLAN, приоритет PoE и режим Extend до 220 м.',
		sources: ['https://seglobaltech.com/wp-content/uploads/TC-P3S010-F-0820-AT-90.pdf'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 10),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 8),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '2 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 90, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			b('poe_watchdog', 'PoE Watchdog', groups.network, true),
			b('port_isolation', 'Изоляция PoE-портов', groups.network, true),
			b('poe_priority', 'Приоритет PoE-портов', groups.network, true),
			n('extend_distance', 'Дальность в режиме Extend', groups.network, 220, 'м'),
			n('switching_capacity', 'Коммутационная способность', groups.network, 2, 'Гбит/с'),
			t('mac_table', 'Таблица MAC-адресов', groups.network, '2K'),
			t('power_supply', 'Питание', groups.power, '100–240 В AC; 52 В / 1,92 А'),
			n('surge_protection', 'Грозозащита портов', groups.protection, 4, 'кВ'),
			t('dimensions', 'Габариты', groups.installation, '200 × 118 × 44 мм'),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от −10 до +50 °C'),
		],
	}],
	[14578, {
		model: 'RL-SW4P2',
		summary: 'Неуправляемый PoE-коммутатор Redline с четырьмя портами PoE+ и двумя uplink-портами. Поддерживает бюджет 60 Вт, Watchdog, изоляцию портов, QoS и передачу до 250 м.',
		sources: ['https://redline-cctv.ru/catalog/video_observation/activenetwork/switchaccess/'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 6),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 4),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '2 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 60, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			...redlineFunctions(),
			b('qos', 'Аппаратный QoS', groups.network, true),
			t('power_supply', 'Питание', groups.power, 'DC 52 В, блок питания в комплекте'),
			t('mounting', 'Монтаж', groups.installation, 'стена / DIN-рейка / плоскость', true),
			t('dimensions', 'Габариты', groups.installation, '125 × 75 × 27 мм'),
		],
	}],
	[18098, {
		model: 'RL-SW16P2S2.ZE',
		summary: 'Неуправляемый полностью гигабитный PoE-коммутатор Redline с 16 портами PoE+, двумя RJ45 uplink и двумя SFP. Бюджет PoE — 150 Вт; поддерживаются Watchdog, изоляция портов и режим Extend до 250 м.',
		sources: ['https://redline-cctv.ru/catalog/video_observation/activenetwork/switchaccess/rl-sw16p2s2.ze/'],
		identityCorrection: {
			itemName: '18-портовый неуправляемый PoE-коммутатор RL-SW16P2S2.ZE',
			model: 'RL-SW16P2S2.ZE',
		},
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего сетевых портов', groups.ports, 20),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 16),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 1000, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты RJ45', groups.ports, '2 × RJ45 1 Гбит/с', true),
			n('sfp_ports_count', 'Количество SFP-портов', groups.ports, 2),
			n('sfp_port_speed', 'Скорость SFP-портов', groups.ports, 1000, 'Мбит/с'),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 150, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			...redlineFunctions(),
			n('switching_capacity', 'Коммутационная способность', groups.network, 40, 'Гбит/с'),
			t('mac_table', 'Таблица MAC-адресов', groups.network, '5K'),
			t('power_supply', 'Питание', groups.power, '110–240 В AC, встроенный блок питания'),
			n('surge_protection', 'Грозозащита портов', groups.protection, 6, 'кВ'),
			t('mounting', 'Монтаж', groups.installation, 'стойка 19″ / полка', true),
			o('case_material', 'Материал корпуса', groups.installation, 'Металл'),
			t('dimensions', 'Габариты', groups.installation, '320 × 207 × 44 мм'),
			n('weight', 'Масса', groups.installation, 3500, 'г', false),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от −10 до +50 °C'),
		],
	}],
	[12026, {
		model: 'AT-NS-4P2-60',
		summary: 'Неуправляемый PoE-коммутатор ATIX на шесть портов: четыре PoE+ и два uplink. Поддерживает бюджет 60 Вт, AI-PoE Watchdog, VLAN, QoS и режим CCTV Extend до 250 м.',
		sources: ['https://atix.pro/network-hardware/switches/product-at-ns-4p2-60-f'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 6),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 4),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '2 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 60, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			b('poe_watchdog', 'AI-PoE Watchdog', groups.network, true),
			b('port_isolation', 'Изоляция PoE-портов', groups.network, true),
			b('qos', 'QoS', groups.network, true),
			n('extend_distance', 'Дальность в режиме Extend', groups.network, 250, 'м'),
			n('switching_capacity', 'Коммутационная способность', groups.network, 1.2, 'Гбит/с'),
			t('mac_table', 'Таблица MAC-адресов', groups.network, '2K'),
			n('surge_protection', 'Грозозащита', groups.protection, 6, 'кВ'),
			t('power_supply', 'Питание', groups.power, 'DC 48–57 В, блок питания в комплекте'),
			t('dimensions', 'Габариты', groups.installation, '125 × 75 × 27 мм'),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от 0 до +55 °C'),
		],
	}],
	[11624, {
		model: 'RL-SW8P2.SE',
		summary: 'Неуправляемый PoE-коммутатор Redline версии SE с восемью портами PoE+ и двумя uplink-портами. Поддерживает бюджет 96 Вт, Watchdog, VLAN, QoS и дальность до 250 м.',
		sources: ['https://www.telecamera.ru/catalog/Videonablyudenie/IP_videonablyudenie/Setevoe_oborudovanie/PoE/Kommutatory/REDLINE/RL_SW8P2.SE.htm'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 10),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 8),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '2 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 96, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			...redlineFunctions(),
			b('qos', 'Аппаратный QoS', groups.network, true),
			t('power_supply', 'Питание', groups.power, 'DC 52 В, блок питания в комплекте'),
			t('mounting', 'Монтаж', groups.installation, 'DIN-рейка / стена / плоскость', true),
			t('dimensions', 'Габариты', groups.installation, '184 × 94 × 27 мм'),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от −10 до +50 °C'),
		],
	}],
	[19328, {
		model: 'TL-SG2210P',
		brandCorrection: 'TP-Link',
		summary: 'Управляемый гигабитный PoE+ коммутатор TP-Link Omada: восемь RJ45-портов PoE+ и два гигабитных SFP-слота. Поддерживает централизованное управление Omada, VLAN, QoS, IGMP Snooping, ACL и статическую маршрутизацию.',
		sources: ['https://www.tp-link.com/us/business-networking/poe-switch/tl-sg2210p/'],
		attributes: [
			...common.managed,
			n('ports_count', 'Всего сетевых портов', groups.ports, 10),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 8),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 1000, 'Мбит/с'),
			n('sfp_ports_count', 'Количество SFP-портов', groups.ports, 2),
			n('sfp_port_speed', 'Скорость SFP-портов', groups.ports, 1000, 'Мбит/с'),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			r('poe_budget', 'Бюджет PoE (зависит от аппаратной версии)', groups.poe, 58, 61, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			o('management_platform', 'Платформа управления', groups.network, 'Omada SDN'),
			b('vlan', 'IEEE 802.1Q VLAN', groups.network, true),
			b('qos', 'L2/L3/L4 QoS', groups.network, true),
			b('igmp_snooping', 'IGMP Snooping', groups.network, true),
			b('static_routing', 'Статическая маршрутизация', groups.network, true),
			b('acl', 'Списки контроля доступа ACL', groups.network, true),
			b('stp', 'STP / RSTP / MSTP', groups.network, true),
			o('management_interfaces', 'Интерфейсы управления', groups.network, 'Web / CLI / SNMP / RMON'),
			o('case_material', 'Материал корпуса', groups.installation, 'Металл'),
			t('mounting', 'Монтаж', groups.installation, 'настольный / стойка', true),
		],
	}],
	[12024, {
		model: 'AT-NS-8P2-96',
		summary: 'Неуправляемый PoE-коммутатор ATIX на десять портов: восемь PoE+ и два uplink. Поддерживает бюджет 96 Вт, AI-PoE Watchdog, VLAN, QoS и режим CCTV Extend до 250 м.',
		sources: ['https://atix.pro/network-hardware/switches/product-at-ns-8p2-96-f'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 10),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 8),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '2 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 96, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			b('poe_watchdog', 'AI-PoE Watchdog', groups.network, true),
			b('port_isolation', 'Изоляция PoE-портов', groups.network, true),
			b('qos', 'QoS', groups.network, true),
			n('extend_distance', 'Дальность в режиме Extend', groups.network, 250, 'м'),
			n('switching_capacity', 'Коммутационная способность', groups.network, 2, 'Гбит/с'),
			t('mac_table', 'Таблица MAC-адресов', groups.network, '2K'),
			n('surge_protection', 'Грозозащита', groups.protection, 6, 'кВ'),
			t('power_supply', 'Питание', groups.power, 'DC 48–57 В, блок питания в комплекте'),
			o('case_material', 'Материал корпуса', groups.installation, 'Металл'),
			t('dimensions', 'Габариты', groups.installation, '184 × 94 × 27 мм'),
			n('weight', 'Масса', groups.installation, 950, 'г', false),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от 0 до +40 °C'),
		],
	}],
	[13564, {
		model: 'S-6/4PA',
		summary: 'Неуправляемый PoE-коммутатор EL с четырьмя портами PoE+ и двумя uplink-портами. Поддерживает бюджет до 65 Вт, Watchdog и увеличенную дальность передачи до 250 м.',
		sources: ['https://optimus-cctv.ru/files/%D0%A0%D1%83%D0%BA%D0%BE%D0%B2%D0%BE%D0%B4%D1%81%D1%82%D0%B2%D0%BE_%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8F_%D0%9A%D0%BE%D0%BC%D0%BC%D1%83%D1%82%D0%B0%D1%82%D0%BE%D1%80_EL_S-108PA_EL_S-64PA.pdf'],
		attributes: [
			...common.unmanaged,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 6),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 4),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '2 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 65, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			b('poe_watchdog', 'PoE Watchdog', groups.network, true),
			n('extend_distance', 'Дальность в режиме Extend', groups.network, 250, 'м'),
			o('switching_method', 'Метод коммутации', groups.network, 'Store-and-Forward'),
			t('power_supply', 'Питание', groups.power, '100–240 В AC, встроенный блок питания'),
			o('cooling', 'Охлаждение', groups.installation, 'Пассивное'),
			t('dimensions', 'Габариты', groups.installation, '200 × 140 × 44,8 мм'),
			n('weight', 'Масса', groups.installation, 680, 'г', false),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от −35 до +65 °C'),
		],
	}],
	[12060, {
		model: 'RL-POE.BOX',
		summary: 'Уличная монтажная коробка Redline со встроенным PoE-коммутатором для подключения двух камер по одному входящему кабелю Ethernet. Защищает соединения и оборудование от осадков и пыли.',
		sources: [
			'https://www.skyros.ru/seistemy_videonablyudeniya/?order=desc&page=31&sort=price',
			'https://www.telecamera.ru/catalog/Videonablyudenie/Termokozhukhi_i_kronshtejny/REDLINE/RL_BR8.htm',
		],
		identityCorrection: {
			itemName: 'Монтажная коробка на 2 камеры со встроенным PoE-коммутатором RL-POE.BOX',
			model: 'RL-POE.BOX',
		},
		attributes: [
			o('device_type', 'Тип устройства', groups.main, 'Монтажная коробка со встроенным PoE-коммутатором'),
			o('management_type', 'Управление', groups.main, 'Неуправляемый'),
			o('connection', 'Подключение', groups.ports, 'Ethernet / PoE'),
			n('camera_connections_count', 'Количество подключаемых камер', groups.ports, 2),
			t('network_layout', 'Схема подключения', groups.ports, 'две камеры по одному входящему кабелю RJ45'),
			o('protection_rating', 'Степень защиты', groups.protection, 'IP67'),
			o('case_material', 'Материал корпуса', groups.installation, 'Армированный термостойкий пластик'),
			t('cable_entry', 'Вывод кабеля', groups.installation, 'изнутри'),
			t('mounting', 'Монтаж', groups.installation, 'наружный монтаж рядом с камерами', true),
			t('operating_temperature', 'Рабочая температура', groups.operation, 'от −45 до +60 °C'),
			t('compatibility', 'Совместимый адаптер', groups.installation, 'Redline RL-BR8'),
		],
	}],
	[11912, {
		model: 'RL-SW4P1.XE',
		summary: 'Управляемый PoE-коммутатор Redline с четырьмя PoE-портами и одним uplink-портом. Поддерживает визуализацию топологии через Redline Client, Watchdog, уведомления и режим Extend до 250 м.',
		sources: ['https://www.telecamera.ru/catalog/Videonablyudenie/IP_videonablyudenie/Setevoe_oborudovanie/PoE/Kommutatory/REDLINE/RL_SW4P1.XE.htm'],
		attributes: [
			...common.managed,
			n('ports_count', 'Всего Ethernet-портов', groups.ports, 5),
			n('poe_ports_count', 'Количество PoE-портов', groups.ports, 4),
			n('poe_port_speed', 'Скорость PoE-портов', groups.ports, 100, 'Мбит/с'),
			t('uplink_ports', 'Uplink-порты', groups.ports, '1 × RJ45 10/100 Мбит/с', true),
			o('poe_standard', 'Стандарты PoE', groups.poe, 'IEEE 802.3af/at'),
			n('poe_budget', 'Бюджет PoE', groups.poe, 52, 'Вт'),
			n('poe_power_per_port', 'Максимальная мощность на порт', groups.poe, 30, 'Вт'),
			b('poe_watchdog', 'PoE Watchdog', groups.network, true),
			n('extend_distance', 'Дальность в режиме Extend', groups.network, 250, 'м'),
			o('management_platform', 'Управление и мониторинг', groups.network, 'Redline Client'),
			b('network_topology', 'Визуализация топологии', groups.network, true),
			b('push_notifications', 'Push-уведомления о сбоях', groups.network, true),
			t('power_supply', 'Питание', groups.power, 'DC 48 В, блок питания в комплекте'),
			n('surge_protection', 'Защита от перенапряжения', groups.protection, 4, 'кВ'),
			n('esd_protection', 'Защита от статики', groups.protection, 6, 'кВ'),
			t('mounting', 'Монтаж', groups.installation, 'стена / плоскость, FlexiFix', true),
			o('case_material', 'Материал корпуса', groups.installation, 'Металл'),
			t('dimensions', 'Габариты', groups.installation, '110 × 82 × 30 мм'),
		],
	}],
]);

const positiveRows = scope.rows
	.filter((row) => row.isCandidate && row.disabled === 0 && row.stockTotal > 0)
	.sort((left, right) => right.stockTotal - left.stockTotal || left.id - right.id);

const missingProfiles = positiveRows.filter((row) => !profiles.has(row.id));
const extraProfiles = [...profiles.keys()].filter((id) => !positiveRows.some((row) => row.id === id));
if (missingProfiles.length || extraProfiles.length) {
	throw new Error(`Profile mismatch. Missing: ${missingProfiles.map((row) => row.id).join(', ')}; extra: ${extraProfiles.join(', ')}`);
}

const products = positiveRows.map((row) => {
	const profile = profiles.get(row.id);
	const attributes = profile.attributes.map((attribute, index) => ({
		order: index + 1,
		...attribute,
		status: attribute.filterable ? 'Готово для фильтра' : 'Справочно',
	}));
	const displayDescription = [
		profile.summary,
		'',
		'Характеристики:',
		...attributes.map((attribute) => `• ${attribute.label}: ${attribute.rawValue}`),
	].join('\n');
	return {
		productId: row.id,
		currentName: profile.identityCorrection?.itemName ?? row.name,
		model: profile.identityCorrection?.model ?? profile.model,
		categoryKey: 'poe_switch',
		shortDescription: profile.summary,
		displayDescription,
		attributes,
		sourceUrls: profile.sources,
		sourceBasis: profile.sources.some((url) => /redline-cctv|keenetic\.com|help\.keenetic|tiandy|tp-link|atix\.pro|optimus-cctv/u.test(url))
			? 'manufacturer_or_official_documentation'
			: 'specialized_product_source',
		keepExistingImage: true,
		image: null,
		sourcePackage: 'poe-switches-current-stock-20260729',
		stockSnapshot: row.stockTotal,
		...(profile.brandCorrection ? { brandCorrection: profile.brandCorrection } : {}),
		...(profile.identityCorrection ? { identityCorrection: profile.identityCorrection } : {}),
	};
});

const excluded = scope.rows
	.filter((row) => row.isCandidate && !(row.disabled === 0 && row.stockTotal > 0))
	.map((row) => ({
		productId: row.id,
		currentName: row.name,
		model: row.model,
		reason: row.disabled ? 'Карточка отключена' : 'Нет положительного остатка',
		stockSnapshot: row.stockTotal,
	}));

const qa = {
	expectedProducts: positiveRows.length,
	products: products.length,
	excludedWithoutPositiveStock: excluded.length,
	withExistingImage: products.filter((product) => {
		const row = positiveRows.find((candidate) => candidate.id === product.productId);
		return Boolean(row?.image);
	}).length,
	withSources: products.filter((product) => product.sourceUrls.length > 0).length,
	withAtLeastTenAttributes: products.filter((product) => product.attributes.length >= 10).length,
	filterReadyAttributes: products.reduce(
		(total, product) => total + product.attributes.filter((attribute) => attribute.filterable).length,
		0,
	),
	brandCorrections: products.filter((product) => product.brandCorrection).map((product) => ({
		productId: product.productId,
		brand: product.brandCorrection,
	})),
	identityCorrections: products.filter((product) => product.identityCorrection).map((product) => ({
		productId: product.productId,
		...product.identityCorrection,
	})),
	checks: {
		allPositiveStock: products.every((product) => product.stockSnapshot > 0),
		noWifiAttribute: products.every((product) => !product.attributes.some((attribute) => attribute.key === 'wifi')),
		allHaveDeviceType: products.every((product) => product.attributes.some((attribute) => attribute.key === 'device_type')),
		allHaveConnection: products.every((product) => product.attributes.some((attribute) => attribute.key === 'connection')),
		allKeepExistingImage: products.every((product) => product.keepExistingImage && product.image == null),
	},
};

if (Object.values(qa.checks).some((value) => value !== true)) {
	throw new Error(`QA failed: ${JSON.stringify(qa.checks)}`);
}

const output = {
	version: 1,
	generatedAt: new Date().toISOString(),
	vendorKey: 'poe-switches',
	scope: {
		category: 'PoE-коммутаторы',
		rule: 'Только активные складские карточки с положительным суммарным остатком',
		sourceScopePath: path.relative(process.cwd(), scopePath),
	},
	products,
	alreadyApplied: [],
	blocked: [],
	excluded,
	sourcePackages: ['poe-switches-current-stock-20260729'],
	qa,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, qa }, null, 2));
