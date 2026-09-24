import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const outDir = path.resolve('local-artifacts/ezviz-cameras-20260728');
const imageDir = path.join(outDir, 'images');
const officialImageDir = path.join(outDir, 'official-images');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function attr(label, rawValue, {
	key = 'additional_characteristic',
	group = 'Дополнительно',
	type = 'text',
	normalizedValue = rawValue,
	numberValue = null,
	numberMin = null,
	numberMax = null,
	unit = '',
	booleanValue = null,
	filterable = false,
} = {}) {
	return {
		key,
		label,
		sourceLabel: label,
		group,
		type,
		rawValue,
		normalizedValue: String(normalizedValue),
		numberValue,
		numberMin,
		numberMax,
		unit,
		booleanValue,
		filterable,
		status: filterable ? 'Готово для фильтра' : 'Только для отображения',
	};
}

const yesNo = (label, value, options = {}) => attr(label, value ? 'Да' : 'Нет', {
	type: 'boolean',
	normalizedValue: value ? 'Да' : 'Нет',
	booleanValue: value,
	filterable: true,
	...options,
});

const definitions = [
	{
		productId: 11170,
		currentName: 'Wi‑Fi-видеокамера H8c',
		model: 'H8c',
		sourceUrls: [
			'https://www.ezviz.com/product/H8c/43162',
			'https://support.ezviz.com/download/H8c',
		],
		sourceBasis: 'Официальная карточка и центр поддержки EZVIZ',
		summary: 'Наружная поворотно-наклонная Wi‑Fi-камера EZVIZ H8c с разрешением 1080p, обнаружением человека, автослежением, цветным ночным видением и двусторонней связью.',
		keepExistingImage: true,
		attributes: [
			attr('Полное обозначение', 'CS-H8c (1080P)'),
			attr('Тип камеры', 'IP-камера Wi‑Fi', { key: 'camera_type', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Место установки', 'улица', { key: 'installation_location', group: 'Основные характеристики', type: 'option', normalizedValue: 'Уличная', filterable: true }),
			attr('Исполнение', 'поворотно-наклонная', { key: 'form_factor', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Матрица', '1/3″ CMOS с прогрессивным сканированием', { key: 'sensor', group: 'Видео', type: 'option', filterable: true }),
			attr('Разрешение', '2 Мп, 1920 × 1080', { key: 'resolution', group: 'Видео', type: 'option', normalizedValue: '2 Мп (1920 × 1080)', filterable: true }),
			attr('Разрешение матрицы', '2 Мп', { key: 'megapixels', group: 'Видео', type: 'number', normalizedValue: '2', numberValue: 2, unit: 'Мп', filterable: true }),
			attr('Максимальная частота кадров', '30 кадров/с', { key: 'frame_rate', group: 'Видео', type: 'number', normalizedValue: '30', numberValue: 30, unit: 'к/с', filterable: true }),
			attr('Объектив', '4 мм F2.0 или 6 мм F2.0 — зависит от модификации', { key: 'lens', group: 'Видео', type: 'option', normalizedValue: '4 или 6 мм', unit: 'мм', filterable: true }),
			attr('Угол обзора', 'до 104° по диагонали (объектив 4 мм)', { key: 'view_angle', group: 'Видео', type: 'number', normalizedValue: '104', numberValue: 104, unit: '°', filterable: true }),
			attr('Поворот и наклон', 'поворот 350°, наклон 80°', { key: 'pan_tilt', group: 'Видео', type: 'option', filterable: true }),
			attr('Дальность ночного видения', 'до 30 м', { key: 'night_vision_distance', group: 'Видео', type: 'number', normalizedValue: '30', numberValue: 30, unit: 'м', filterable: true }),
			attr('Режимы ночного видения', 'инфракрасный; цветной; интеллектуальный', { key: 'night_vision', group: 'Видео', type: 'multi_option', filterable: true }),
			attr('Сжатие видео', 'H.265; H.264', { key: 'video_compression', group: 'Видео', type: 'multi_option', filterable: true }),
			attr('Аудио', 'двусторонняя аудиосвязь', { key: 'audio', group: 'Видео и аудио', type: 'option', filterable: true }),
			attr('Видеоаналитика', 'обнаружение человека; настраиваемая зона', { key: 'analytics', group: 'Функции', type: 'multi_option', filterable: true }),
			yesNo('Автоматическое слежение', true, { key: 'auto_tracking', group: 'Функции' }),
			attr('Активная защита', 'сирена и световая сигнализация', { key: 'active_defense', group: 'Функции', type: 'multi_option', filterable: true }),
			yesNo('Wi‑Fi', true, { key: 'wifi', group: 'Подключения' }),
			attr('Стандарт Wi‑Fi', 'IEEE 802.11 b/g/n, 2,4 ГГц', { key: 'wifi_standard', group: 'Подключения', type: 'option', normalizedValue: '802.11 b/g/n, 2,4 ГГц', filterable: true }),
			yesNo('Проводная сеть', true, { key: 'wired_network', group: 'Подключения' }),
			attr('Проводная сеть', 'RJ45, Ethernet 10/100 Мбит/с', { key: 'network_interface', group: 'Подключения', type: 'option', filterable: true }),
			attr('Локальное хранение', 'MicroSD до 512 ГБ', { key: 'storage_support', group: 'Хранение', type: 'option', normalizedValue: 'MicroSD', filterable: true }),
			attr('Максимальный объём карты памяти', '512 ГБ', { key: 'memory_card_capacity', group: 'Хранение', type: 'number', normalizedValue: '512', numberValue: 512, unit: 'ГБ', filterable: true }),
			attr('Питание', '12 В DC, 1 А', { key: 'power_supply', group: 'Питание', type: 'text', filterable: true }),
			attr('Максимальная потребляемая мощность', '12 Вт', { key: 'power_consumption', group: 'Питание', type: 'number', normalizedValue: '12', numberValue: 12, unit: 'Вт', filterable: true }),
			attr('Погодозащита', 'погодоустойчивое исполнение', { key: 'protection_rating', group: 'Эксплуатация', type: 'option', filterable: true }),
			attr('Рабочая температура', '−30…+50 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-30…50', numberMin: -30, numberMax: 50, unit: '°C', filterable: true }),
			attr('Габариты', '100,05 × 129,19 × 149,75 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса нетто', '550 г', { key: 'weight', group: 'Размеры', type: 'number', normalizedValue: '550', numberValue: 550, unit: 'г', filterable: true }),
		],
	},
	{
		productId: 11226,
		currentName: 'Wi‑Fi-видеокамера CS-H8',
		model: 'CS-H8',
		sourceUrls: ['https://www.ezviz.com/es/product/h8%2Bpro%2B3k/53467'],
		sourceBasis: 'Официальная карточка EZVIZ H8 Pro 3K',
		summary: 'Наружная поворотно-наклонная Wi‑Fi-камера EZVIZ H8 Pro 3K с разрешением 5 Мп, распознаванием людей и автомобилей, автослежением и цветным ночным видением.',
		imageSource: '11226-h8-pro-3k.jpg',
		attributes: [
			attr('Полное обозначение серии', 'CS-H8-R100-1J5WKFL'),
			attr('Тип камеры', 'IP-камера Wi‑Fi', { key: 'camera_type', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Место установки', 'улица', { key: 'installation_location', group: 'Основные характеристики', type: 'option', normalizedValue: 'Уличная', filterable: true }),
			attr('Исполнение', 'поворотно-наклонная', { key: 'form_factor', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Матрица', '1/2,7″ CMOS с прогрессивным сканированием', { key: 'sensor', group: 'Видео', type: 'option', filterable: true }),
			attr('Разрешение', '5 Мп, 2880 × 1620', { key: 'resolution', group: 'Видео', type: 'option', normalizedValue: '5 Мп (2880 × 1620)', filterable: true }),
			attr('Разрешение матрицы', '5 Мп', { key: 'megapixels', group: 'Видео', type: 'number', normalizedValue: '5', numberValue: 5, unit: 'Мп', filterable: true }),
			attr('Максимальная частота кадров', '30 кадров/с', { key: 'frame_rate', group: 'Видео', type: 'number', normalizedValue: '30', numberValue: 30, unit: 'к/с', filterable: true }),
			attr('Объектив', '4 мм F1.6 или 6 мм F1.6 — зависит от модификации', { key: 'lens', group: 'Видео', type: 'option', normalizedValue: '4 или 6 мм', unit: 'мм', filterable: true }),
			attr('Угол обзора', 'до 104° по диагонали (объектив 4 мм)', { key: 'view_angle', group: 'Видео', type: 'number', normalizedValue: '104', numberValue: 104, unit: '°', filterable: true }),
			attr('Поворот и наклон', 'поворот 340°, наклон 80°', { key: 'pan_tilt', group: 'Видео', type: 'option', filterable: true }),
			attr('Дальность ночного видения', 'до 30 м', { key: 'night_vision_distance', group: 'Видео', type: 'number', normalizedValue: '30', numberValue: 30, unit: 'м', filterable: true }),
			attr('Режимы ночного видения', 'инфракрасный; цветной; интеллектуальный', { key: 'night_vision', group: 'Видео', type: 'multi_option', filterable: true }),
			attr('Сжатие видео', 'H.265; H.264', { key: 'video_compression', group: 'Видео', type: 'multi_option', filterable: true }),
			attr('Аудио', 'двусторонняя аудиосвязь', { key: 'audio', group: 'Видео и аудио', type: 'option', filterable: true }),
			attr('Видеоаналитика', 'обнаружение людей; обнаружение автомобилей; распознавание жеста рукой', { key: 'analytics', group: 'Функции', type: 'multi_option', filterable: true }),
			yesNo('Автоматическое слежение', true, { key: 'auto_tracking', group: 'Функции' }),
			attr('Активная защита', 'сирена и световая сигнализация', { key: 'active_defense', group: 'Функции', type: 'multi_option', filterable: true }),
			yesNo('Wi‑Fi', true, { key: 'wifi', group: 'Подключения' }),
			attr('Стандарт Wi‑Fi', 'IEEE 802.11 b/g/n, 2,4 ГГц', { key: 'wifi_standard', group: 'Подключения', type: 'option', normalizedValue: '802.11 b/g/n, 2,4 ГГц', filterable: true }),
			yesNo('Проводная сеть', true, { key: 'wired_network', group: 'Подключения' }),
			attr('Проводная сеть', 'RJ45, Ethernet 10/100 Мбит/с', { key: 'network_interface', group: 'Подключения', type: 'option', filterable: true }),
			attr('Локальное хранение', 'MicroSD до 512 ГБ', { key: 'storage_support', group: 'Хранение', type: 'option', normalizedValue: 'MicroSD', filterable: true }),
			attr('Максимальный объём карты памяти', '512 ГБ', { key: 'memory_card_capacity', group: 'Хранение', type: 'number', normalizedValue: '512', numberValue: 512, unit: 'ГБ', filterable: true }),
			attr('Питание', '12 В DC, 1 А', { key: 'power_supply', group: 'Питание', type: 'text', filterable: true }),
			attr('Максимальная потребляемая мощность', '6 Вт', { key: 'power_consumption', group: 'Питание', type: 'number', normalizedValue: '6', numberValue: 6, unit: 'Вт', filterable: true }),
			attr('Погодозащита', 'погодоустойчивое исполнение', { key: 'protection_rating', group: 'Эксплуатация', type: 'option', filterable: true }),
			attr('Рабочая температура', '−20…+50 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-20…50', numberMin: -20, numberMax: 50, unit: '°C', filterable: true }),
			attr('Габариты', '116 × 153,2 × 163,8 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса нетто', '592 г', { key: 'weight', group: 'Размеры', type: 'number', normalizedValue: '592', numberValue: 592, unit: 'г', filterable: true }),
		],
	},
	{
		productId: 11568,
		currentName: 'Wi‑Fi-видеокамера CS-BC2',
		model: 'CS-BC2',
		sourceUrls: ['https://www.ezviz.com/inter/product/bc2/39984'],
		sourceBasis: 'Официальная карточка EZVIZ BC2',
		summary: 'Компактная аккумуляторная Wi‑Fi-камера EZVIZ BC2 для помещений: видео 1080p, ИК-подсветка, обнаружение человека, двусторонняя связь и магнитное основание.',
		imageSource: '11568-bc2.jpg',
		attributes: [
			attr('Полное обозначение', 'CS-BC2 (A0-2C2WPFB)'),
			attr('Тип камеры', 'аккумуляторная IP-камера Wi‑Fi', { key: 'camera_type', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Место установки', 'помещение', { key: 'installation_location', group: 'Основные характеристики', type: 'option', normalizedValue: 'Внутренняя', filterable: true }),
			attr('Исполнение', 'компактная фиксированная', { key: 'form_factor', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Матрица', '1/2,8″, 2 Мп CMOS с прогрессивным сканированием', { key: 'sensor', group: 'Видео', type: 'option', filterable: true }),
			attr('Разрешение', '2 Мп, 1920 × 1080', { key: 'resolution', group: 'Видео', type: 'option', normalizedValue: '2 Мп (1920 × 1080)', filterable: true }),
			attr('Разрешение матрицы', '2 Мп', { key: 'megapixels', group: 'Видео', type: 'number', normalizedValue: '2', numberValue: 2, unit: 'Мп', filterable: true }),
			attr('Максимальная частота кадров', '15 кадров/с', { key: 'frame_rate', group: 'Видео', type: 'number', normalizedValue: '15', numberValue: 15, unit: 'к/с', filterable: true }),
			attr('Объектив', '4 мм F1.6', { key: 'lens', group: 'Видео', type: 'option', normalizedValue: '4 мм', unit: 'мм', filterable: true }),
			attr('Угол обзора', '100°; 85° по диагонали; 46° по горизонтали', { key: 'view_angle', group: 'Видео', type: 'number', normalizedValue: '100', numberValue: 100, unit: '°', filterable: true }),
			attr('Дальность ночного видения', 'до 5 м', { key: 'night_vision_distance', group: 'Видео', type: 'number', normalizedValue: '5', numberValue: 5, unit: 'м', filterable: true }),
			attr('Ночное видение', 'инфракрасное', { key: 'night_vision', group: 'Видео', type: 'option', filterable: true }),
			attr('Сжатие видео', 'H.265; H.264', { key: 'video_compression', group: 'Видео', type: 'multi_option', filterable: true }),
			attr('Аудио', 'двусторонняя аудиосвязь', { key: 'audio', group: 'Видео и аудио', type: 'option', filterable: true }),
			attr('Видеоаналитика', 'PIR-обнаружение движения человека; настраиваемая зона', { key: 'analytics', group: 'Функции', type: 'multi_option', filterable: true }),
			yesNo('Wi‑Fi', true, { key: 'wifi', group: 'Подключения' }),
			attr('Стандарт Wi‑Fi', 'IEEE 802.11 b/g/n, 2,4 ГГц', { key: 'wifi_standard', group: 'Подключения', type: 'option', normalizedValue: '802.11 b/g/n, 2,4 ГГц', filterable: true }),
			yesNo('Проводная сеть', false, { key: 'wired_network', group: 'Подключения' }),
			attr('Локальное хранение', 'MicroSD до 256 ГБ', { key: 'storage_support', group: 'Хранение', type: 'option', normalizedValue: 'MicroSD', filterable: true }),
			attr('Максимальный объём карты памяти', '256 ГБ', { key: 'memory_card_capacity', group: 'Хранение', type: 'number', normalizedValue: '256', numberValue: 256, unit: 'ГБ', filterable: true }),
			attr('Аккумулятор', '2000 мА·ч', { key: 'battery_capacity', group: 'Питание', type: 'number', normalizedValue: '2000', numberValue: 2000, unit: 'мА·ч', filterable: true }),
			attr('Автономная работа', 'до 50 дней при типовом сценарии EZVIZ'),
			attr('Питание для зарядки', '5 В DC, 2 А; адаптер приобретается отдельно', { key: 'power_supply', group: 'Питание', type: 'text', filterable: true }),
			attr('Монтаж', 'магнитное основание', { key: 'mounting_type', group: 'Монтаж', type: 'option', filterable: true }),
			attr('Рабочая температура', '−10…+45 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-10…45', numberMin: -10, numberMax: 45, unit: '°C', filterable: true }),
			attr('Габариты', '51,3 × 39,1 × 39,1 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса без кронштейна', '85,6 г', { key: 'weight', group: 'Размеры', type: 'number', normalizedValue: '85.6', numberValue: 85.6, unit: 'г', filterable: true }),
			attr('Цвет', 'чёрный', { key: 'color', group: 'Внешний вид', type: 'option', filterable: true }),
		],
	},
	{
		productId: 11570,
		currentName: 'Wi‑Fi-видеокамера H1c',
		model: 'H1c',
		sourceUrls: ['https://www.ezviz.com/cis/product/H1c/62891'],
		sourceBasis: 'Официальная карточка EZVIZ H1c',
		summary: 'Компактная внутренняя Wi‑Fi-камера EZVIZ H1c с разрешением 1080p, широким углом обзора, ИК-подсветкой до 10 м, обнаружением движения и двусторонней связью.',
		imageSource: '11570-h1c.jpg',
		attributes: [
			attr('Полное обозначение', 'CS-H1c'),
			attr('Тип камеры', 'IP-камера Wi‑Fi', { key: 'camera_type', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Место установки', 'помещение', { key: 'installation_location', group: 'Основные характеристики', type: 'option', normalizedValue: 'Внутренняя', filterable: true }),
			attr('Исполнение', 'компактная фиксированная', { key: 'form_factor', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Матрица', '1/3″ CMOS с прогрессивным сканированием', { key: 'sensor', group: 'Видео', type: 'option', filterable: true }),
			attr('Разрешение', '2 Мп, 1920 × 1080', { key: 'resolution', group: 'Видео', type: 'option', normalizedValue: '2 Мп (1920 × 1080)', filterable: true }),
			attr('Разрешение матрицы', '2 Мп', { key: 'megapixels', group: 'Видео', type: 'number', normalizedValue: '2', numberValue: 2, unit: 'Мп', filterable: true }),
			attr('Максимальная частота кадров', '25 кадров/с', { key: 'frame_rate', group: 'Видео', type: 'number', normalizedValue: '25', numberValue: 25, unit: 'к/с', filterable: true }),
			attr('Объектив', '2,8 мм', { key: 'lens', group: 'Видео', type: 'option', normalizedValue: '2,8 мм', unit: 'мм', filterable: true }),
			attr('Угол обзора', '108° по диагонали, 91° по горизонтали, 50° по вертикали', { key: 'view_angle', group: 'Видео', type: 'number', normalizedValue: '108', numberValue: 108, unit: '°', filterable: true }),
			attr('Дальность ночного видения', 'до 10 м', { key: 'night_vision_distance', group: 'Видео', type: 'number', normalizedValue: '10', numberValue: 10, unit: 'м', filterable: true }),
			attr('Ночное видение', 'инфракрасное', { key: 'night_vision', group: 'Видео', type: 'option', filterable: true }),
			attr('Сжатие видео', 'H.264 Main Profile', { key: 'video_compression', group: 'Видео', type: 'option', normalizedValue: 'H.264', filterable: true }),
			attr('Аудио', 'двусторонняя аудиосвязь', { key: 'audio', group: 'Видео и аудио', type: 'option', filterable: true }),
			attr('Видеоаналитика', 'обнаружение движения; настраиваемая зона', { key: 'analytics', group: 'Функции', type: 'multi_option', filterable: true }),
			attr('Звуковое оповещение', 'без звука; короткий сигнал; сирена', { key: 'sound_alert', group: 'Функции', type: 'multi_option', filterable: true }),
			yesNo('Режим сна', true, { key: 'sleep_mode', group: 'Функции' }),
			yesNo('Wi‑Fi', true, { key: 'wifi', group: 'Подключения' }),
			attr('Стандарт Wi‑Fi', 'IEEE 802.11 b/g/n, 2,4 ГГц', { key: 'wifi_standard', group: 'Подключения', type: 'option', normalizedValue: '802.11 b/g/n, 2,4 ГГц', filterable: true }),
			attr('Локальное хранение', 'MicroSD до 512 ГБ', { key: 'storage_support', group: 'Хранение', type: 'option', normalizedValue: 'MicroSD', filterable: true }),
			attr('Максимальный объём карты памяти', '512 ГБ', { key: 'memory_card_capacity', group: 'Хранение', type: 'number', normalizedValue: '512', numberValue: 512, unit: 'ГБ', filterable: true }),
			attr('Питание', '5 В DC, 1 А', { key: 'power_supply', group: 'Питание', type: 'text', filterable: true }),
			attr('Максимальная потребляемая мощность', '3 Вт', { key: 'power_consumption', group: 'Питание', type: 'number', normalizedValue: '3', numberValue: 3, unit: 'Вт', filterable: true }),
			attr('Монтаж', 'плоская поверхность или магнитное основание', { key: 'mounting_type', group: 'Монтаж', type: 'multi_option', filterable: true }),
			attr('Рабочая температура', '−10…+45 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-10…45', numberMin: -10, numberMax: 45, unit: '°C', filterable: true }),
			attr('Габариты', '53,89 × 53,89 × 90,3 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса нетто', '87 г', { key: 'weight', group: 'Размеры', type: 'number', normalizedValue: '87', numberValue: 87, unit: 'г', filterable: true }),
			attr('Цвет', 'белый с чёрной лицевой панелью', { key: 'color', group: 'Внешний вид', type: 'option', normalizedValue: 'белый', filterable: true }),
		],
	},
	{
		productId: 14248,
		currentName: 'Wi‑Fi-видеокамера EZVIZ LC1',
		model: 'LC1',
		brandCorrection: 'EZVIZ',
		sourceUrls: [
			'https://www.ezviz.com/eu/product/LC1/1420',
			'https://support.ezviz.com/product/lc1/1257',
		],
		sourceBasis: 'Официальная карточка и центр поддержки EZVIZ',
		summary: 'Наружная Wi‑Fi-камера EZVIZ LC1, совмещённая с двумя прожекторами: Full HD 1080p, PIR-датчик с зоной 270°, ночное видение до 18 м, сирена 100 дБ и двусторонняя связь.',
		imageSource: '14248-lc1.jpg',
		attributes: [
			attr('Полное обозначение', 'CS-LC1-A0-1B2WPFRL'),
			attr('Тип камеры', 'IP-камера Wi‑Fi с прожекторами', { key: 'camera_type', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Место установки', 'улица', { key: 'installation_location', group: 'Основные характеристики', type: 'option', normalizedValue: 'Уличная', filterable: true }),
			attr('Исполнение', 'фиксированная камера с двумя прожекторами', { key: 'form_factor', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Разрешение', '2 Мп, 1920 × 1080', { key: 'resolution', group: 'Видео', type: 'option', normalizedValue: '2 Мп (1920 × 1080)', filterable: true }),
			attr('Разрешение матрицы', '2 Мп', { key: 'megapixels', group: 'Видео', type: 'number', normalizedValue: '2', numberValue: 2, unit: 'Мп', filterable: true }),
			attr('Максимальная частота кадров', '25 кадров/с при 50 Гц; 30 кадров/с при 60 Гц', { key: 'frame_rate', group: 'Видео', type: 'number', normalizedValue: '30', numberValue: 30, unit: 'к/с', filterable: true }),
			attr('Угол обзора', '140° по диагонали, 115° по горизонтали', { key: 'view_angle', group: 'Видео', type: 'number', normalizedValue: '140', numberValue: 140, unit: '°', filterable: true }),
			attr('Дальность ночного видения', 'до 18 м', { key: 'night_vision_distance', group: 'Видео', type: 'number', normalizedValue: '18', numberValue: 18, unit: 'м', filterable: true }),
			attr('Ночное видение', 'инфракрасное', { key: 'night_vision', group: 'Видео', type: 'option', filterable: true }),
			attr('Сжатие видео', 'Smart H.264', { key: 'video_compression', group: 'Видео', type: 'option', normalizedValue: 'H.264', filterable: true }),
			attr('Аудио', 'встроенные микрофон и динамик; двусторонняя связь', { key: 'audio', group: 'Видео и аудио', type: 'option', normalizedValue: 'Двусторонняя связь', filterable: true }),
			attr('Видеоаналитика', 'PIR-обнаружение движения; настраиваемая зона', { key: 'analytics', group: 'Функции', type: 'multi_option', filterable: true }),
			attr('Дальность PIR-датчика', 'до 9,1 м (30 футов)', { key: 'pir_distance', group: 'Функции', type: 'number', normalizedValue: '9.1', numberValue: 9.1, unit: 'м', filterable: true }),
			attr('Зона PIR-датчика', '270°', { key: 'pir_angle', group: 'Функции', type: 'number', normalizedValue: '270', numberValue: 270, unit: '°', filterable: true }),
			attr('Сирена', '100 дБ', { key: 'siren_volume', group: 'Функции', type: 'number', normalizedValue: '100', numberValue: 100, unit: 'дБ', filterable: true }),
			attr('Прожекторы', '2 светодиодных прожектора, суммарно 2500 лм', { key: 'lighting', group: 'Освещение', type: 'text', filterable: true }),
			attr('Цветовая температура света', '3000 К', { key: 'color_temperature', group: 'Освещение', type: 'number', normalizedValue: '3000', numberValue: 3000, unit: 'К', filterable: true }),
			yesNo('Wi‑Fi', true, { key: 'wifi', group: 'Подключения' }),
			attr('Стандарт Wi‑Fi', 'IEEE 802.11 b/g/n, 2,4 ГГц, 2T2R', { key: 'wifi_standard', group: 'Подключения', type: 'option', normalizedValue: '802.11 b/g/n, 2,4 ГГц', filterable: true }),
			attr('Локальное хранение', 'MicroSD до 128 ГБ', { key: 'storage_support', group: 'Хранение', type: 'option', normalizedValue: 'MicroSD', filterable: true }),
			attr('Максимальный объём карты памяти', '128 ГБ', { key: 'memory_card_capacity', group: 'Хранение', type: 'number', normalizedValue: '128', numberValue: 128, unit: 'ГБ', filterable: true }),
			attr('Питание', 'стационарное подключение 110–240 В AC', { key: 'power_supply', group: 'Питание', type: 'text', filterable: true }),
			attr('Потребляемая мощность', 'до 8 Вт', { key: 'power_consumption', group: 'Питание', type: 'number', normalizedValue: '8', numberValue: 8, unit: 'Вт', filterable: true }),
			attr('Степень защиты камеры', 'IP65', { key: 'protection_rating', group: 'Эксплуатация', type: 'option', filterable: true }),
			attr('Рабочая температура', '−30…+50 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-30…50', numberMin: -30, numberMax: 50, unit: '°C', filterable: true }),
			attr('Материал', 'литой алюминий (светильники) и пластик (камера)'),
			attr('Габариты', '196 × 211 × 227 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса', '1757 г', { key: 'weight', group: 'Размеры', type: 'number', normalizedValue: '1757', numberValue: 1757, unit: 'г', filterable: true }),
			attr('Цвет', 'белый', { key: 'color', group: 'Внешний вид', type: 'option', filterable: true }),
		],
	},
	{
		productId: 16094,
		currentName: 'Wi‑Fi-видеокамера EZVIZ CS-C2MINI-31WFR',
		model: 'CS-C2MINI-31WFR',
		brandCorrection: 'EZVIZ',
		sourceUrls: [
			'https://m-support.ezviz.com/faq/article/EZVIZ-EOL-Product-List',
			'https://service.ezviz.com/questions?type=620',
		],
		sourceBasis: 'Точная модель подтверждена официальным списком EZVIZ; технические значения аккуратно перенесены из существующей карточки ERP без добавления данных сторонних продавцов',
		summary: 'Компактная внутренняя Wi‑Fi-камера EZVIZ C2 Mini с разрешением до 1280 × 960, ИК-подсветкой, записью звука, обнаружением движения и поддержкой MicroSD.',
		keepExistingImage: true,
		attributes: [
			attr('Полное обозначение', 'CS-C2mini-31WFR'),
			attr('Статус модели у производителя', 'модель снята с поддержки обновлений 31.12.2025'),
			attr('Тип камеры', 'IP-камера Wi‑Fi', { key: 'camera_type', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Место установки', 'помещение', { key: 'installation_location', group: 'Основные характеристики', type: 'option', normalizedValue: 'Внутренняя', filterable: true }),
			attr('Исполнение', 'компактная фиксированная', { key: 'form_factor', group: 'Основные характеристики', type: 'option', filterable: true }),
			attr('Матрица', '1/3″ CMOS с прогрессивным сканированием', { key: 'sensor', group: 'Видео', type: 'option', filterable: true }),
			attr('Разрешение', '1,3 Мп, 1280 × 960', { key: 'resolution', group: 'Видео', type: 'option', normalizedValue: '1,3 Мп (1280 × 960)', filterable: true }),
			attr('Разрешение матрицы', '1,3 Мп', { key: 'megapixels', group: 'Видео', type: 'number', normalizedValue: '1.3', numberValue: 1.3, unit: 'Мп', filterable: true }),
			attr('Максимальная частота кадров', '25 кадров/с', { key: 'frame_rate', group: 'Видео', type: 'number', normalizedValue: '25', numberValue: 25, unit: 'к/с', filterable: true }),
			attr('Объектив', '2,4 мм', { key: 'lens', group: 'Видео', type: 'option', normalizedValue: '2,4 мм', unit: 'мм', filterable: true }),
			attr('Угол обзора', '115°', { key: 'view_angle', group: 'Видео', type: 'number', normalizedValue: '115', numberValue: 115, unit: '°', filterable: true }),
			attr('Минимальная освещённость', '0,02 лк при F2.2 и включённом AGC; 0 лк с ИК', { key: 'sensitivity', group: 'Видео', type: 'number', normalizedValue: '0.02', numberValue: 0.02, unit: 'лк', filterable: true }),
			attr('Дальность ночного видения', 'до 10 м', { key: 'night_vision_distance', group: 'Видео', type: 'number', normalizedValue: '10', numberValue: 10, unit: 'м', filterable: true }),
			attr('Ночное видение', 'инфракрасное', { key: 'night_vision', group: 'Видео', type: 'option', filterable: true }),
			attr('Сжатие видео', 'H.264', { key: 'video_compression', group: 'Видео', type: 'option', filterable: true }),
			attr('Широкий динамический диапазон', 'WDR', { key: 'wdr', group: 'Видео', type: 'option', filterable: true }),
			attr('Аудио', 'встроенный микрофон; запись звука', { key: 'audio', group: 'Видео и аудио', type: 'option', normalizedValue: 'Встроенный микрофон', filterable: true }),
			attr('Видеоаналитика', 'обнаружение движения', { key: 'analytics', group: 'Функции', type: 'multi_option', filterable: true }),
			yesNo('Wi‑Fi', true, { key: 'wifi', group: 'Подключения' }),
			attr('Беспроводная сеть', 'Wi‑Fi 2,4 ГГц', { key: 'wifi_standard', group: 'Подключения', type: 'option', filterable: true }),
			attr('Локальное хранение', 'MicroSD до 128 ГБ', { key: 'storage_support', group: 'Хранение', type: 'option', normalizedValue: 'MicroSD', filterable: true }),
			attr('Максимальный объём карты памяти', '128 ГБ', { key: 'memory_card_capacity', group: 'Хранение', type: 'number', normalizedValue: '128', numberValue: 128, unit: 'ГБ', filterable: true }),
			attr('Питание', '5 В DC ±10%', { key: 'power_supply', group: 'Питание', type: 'text', filterable: true }),
			attr('Максимальная потребляемая мощность', '3,5 Вт', { key: 'power_consumption', group: 'Питание', type: 'number', normalizedValue: '3.5', numberValue: 3.5, unit: 'Вт', filterable: true }),
			attr('Рабочая температура', '−10…+50 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-10…50', numberMin: -10, numberMax: 50, unit: '°C', filterable: true }),
			attr('Габариты', '91 × 50 × 25 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса', '110 г', { key: 'weight', group: 'Размеры', type: 'number', normalizedValue: '110', numberValue: 110, unit: 'г', filterable: true }),
			attr('Цвет', 'белый', { key: 'color', group: 'Внешний вид', type: 'option', filterable: true }),
		],
	},
];

function runFfmpeg(inputPath, outputPath) {
	return new Promise((resolve, reject) => {
		const child = spawn('ffmpeg', [
			'-hide_banner',
			'-loglevel', 'error',
			'-y',
			'-i', inputPath,
			'-c:v', 'libwebp',
			'-quality', '84',
			'-compression_level', '6',
			outputPath,
		], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const stderr = [];
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.once('error', reject);
		child.once('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(Buffer.concat(stderr).toString('utf8') || `ffmpeg failed (${code})`));
		});
	});
}

await fs.mkdir(imageDir, { recursive: true });
const products = [];
for (const definition of definitions) {
	const attributes = definition.attributes.map((attribute, index) => ({ ...attribute, order: index + 1 }));
	const product = {
		productId: definition.productId,
		currentName: definition.currentName,
		model: definition.model,
		categoryKey: 'camera',
		shortDescription: definition.summary,
		displayDescription: `${definition.summary}\n\nХарактеристики:\n${attributes
			.map((attribute) => `• ${attribute.label}: ${attribute.rawValue}`)
			.join('\n')}`,
		attributes,
		sourceUrls: definition.sourceUrls,
		sourceBasis: definition.sourceBasis,
		brandCorrection: definition.brandCorrection ?? null,
		keepExistingImage: definition.keepExistingImage === true,
	};
	if (definition.imageSource) {
		const inputPath = path.join(officialImageDir, definition.imageSource);
		const outputPath = path.join(imageDir, `${definition.productId}.webp`);
		await runFfmpeg(inputPath, outputPath);
		const buffer = await fs.readFile(outputPath);
		product.image = {
			sourceUrl: definition.sourceUrls[0],
			localPath: path.relative(process.cwd(), outputPath).replaceAll('\\', '/'),
			bytes: buffer.length,
			sha256: sha256(buffer),
			format: 'webp',
			official: true,
		};
	}
	products.push(product);
}

const catalog = {
	version: 1,
	vendorKey: 'ezviz',
	vendor: 'EZVIZ',
	generatedAt: new Date().toISOString(),
	scope: {
		expectedProducts: 6,
		productIds: products.map((product) => product.productId),
		brandCorrections: products.filter((product) => product.brandCorrection).map((product) => ({
			productId: product.productId,
			brand: product.brandCorrection,
		})),
		imageReplacements: products.filter((product) => product.image).map((product) => product.productId),
		imagesKept: products.filter((product) => product.keepExistingImage).map((product) => product.productId),
	},
	products,
};

const catalogPath = path.join(outDir, 'catalog.json');
await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
	catalogPath,
	products: products.length,
	attributes: products.reduce((sum, product) => sum + product.attributes.length, 0),
	filterable: products.reduce((sum, product) => sum + product.attributes.filter((attribute) => attribute.filterable).length, 0),
	imageReplacements: catalog.scope.imageReplacements,
	imagesKept: catalog.scope.imagesKept,
	brandCorrections: catalog.scope.brandCorrections,
}, null, 2));
