import fs from 'node:fs/promises';
import path from 'node:path';

const outputPath = path.resolve('work-catalog-video-20260728/redline-recorder-alias-source.json');
const url = 'https://redline-cctv.ru/catalog/video_observation/setevye_videoregistratory_nvr/seriya_titan/rl-nvr64c-4h/';

const result = {
	version: 1,
	generatedAt: new Date().toISOString(),
	sourceType: 'verified_model_alias',
	sourceLabel: 'Официальный сайт RedLine',
	sourceOrigins: ['redline-cctv.ru'],
	scope: {
		targets: 1,
		matched: 1,
		unmatched: 0,
	},
	matches: [
		{
			id: 13076,
			kind: 'recorder',
			name: 'IP-видеорегистратор RL-NVR64C-4H',
			model: 'RL-NVR64C-4H',
			brand: 'RedLine',
			officialModel: 'RL-NVR64C-4H',
			sourceAlias: 'RL-NVR64H',
			url,
			title: '64-канальный нейросетевой видеорегистратор RedLine RL-NVR64C-4H',
			description: 'Точная модель карточки уточнена пользователем и подтверждена официальной страницей RedLine.',
			specs: [
				{ label: 'Модель', value: 'RL-NVR64C-4H' },
				{ label: 'Бренд', value: 'RedLine' },
				{ label: 'Серия', value: 'TITAN' },
				{ label: 'Тип устройства', value: 'Сетевой видеорегистратор NVR' },
				{ label: 'Количество IP-каналов', value: '64' },
				{ label: 'Максимальное разрешение IP-камеры', value: '12 Мп' },
				{ label: 'Входящая пропускная способность', value: '640 Мбит/с' },
				{ label: 'Исходящая пропускная способность', value: '640 Мбит/с' },
				{ label: 'Форматы сжатия видео', value: 'H.264, H.264+, H.265, H.265+, MJPEG' },
				{ label: 'Форматы сжатия аудио', value: 'G.711A, G.711U, AAC' },
				{ label: 'Количество HDD', value: '4' },
				{ label: 'Интерфейс HDD', value: '4×SATA, каждый диск до 18 ТБ; 1×eSATA' },
				{ label: 'Режимы работы HDD', value: 'Чтение/запись, только чтение, зеркалирование' },
				{ label: 'HDMI-выходы', value: '4' },
				{ label: 'Максимальное разрешение HDMI', value: '8K' },
				{ label: 'Аудиовход', value: '1×RCA' },
				{ label: 'Аудиовыход', value: '1×RCA' },
				{ label: 'Тревожные входы/выходы', value: '16/1' },
				{ label: 'USB', value: '1×USB 2.0, 2×USB 3.0' },
				{ label: 'Сетевой интерфейс', value: '2×RJ45 Gigabit Ethernet' },
				{ label: 'ONVIF', value: 'Profile S, G, T' },
				{ label: 'Видеоаналитика', value: 'Нейросетевая AI: лица, номера автомобилей, люди и транспорт, периметр, линии, подсчёт посетителей' },
				{ label: 'Мобильный доступ', value: 'Redline Cloud P2P' },
				{ label: 'Операционная система', value: 'Linux' },
				{ label: 'Питание', value: '12 В, 5 А; блок питания в комплекте' },
				{ label: 'Рабочая температура', value: 'От -10 до +50 °C' },
				{ label: 'Материал корпуса', value: 'Металл' },
				{ label: 'Габариты', value: '378×325.8×66 мм' },
				{ label: 'Вес', value: '2500 г' },
				{ label: 'Установка', value: 'На полку' },
				{ label: 'Гарантия', value: '3 года' },
			],
			imageUrl: '',
			matchScore: 100_000,
			sourceType: 'verified_model_alias',
			sourceLabel: 'redline-cctv.ru',
		},
	],
	unmatched: [],
};

await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, products: result.matches.length }, null, 2));
