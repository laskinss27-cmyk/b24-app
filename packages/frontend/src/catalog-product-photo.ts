export interface PreparedCatalogPhoto {
	fileName: string;
	mimeType: 'image/jpeg';
	content: string;
	previewUrl: string;
	size: number;
}

function base64Bytes(content: string): number {
	return Math.floor(content.length * 3 / 4) - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);
}

export async function prepareCatalogPhoto(file: File): Promise<PreparedCatalogPhoto> {
	if (!file.type.startsWith('image/')) throw new Error('Выбери изображение JPEG, PNG или WebP.');
	if (file.size > 15 * 1024 * 1024) throw new Error('Исходное фото должно весить не больше 15 МБ.');
	const source = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error('Не удалось прочитать фото.'));
		reader.onload = () => resolve(String(reader.result ?? ''));
		reader.readAsDataURL(file);
	});
	const image = await new Promise<HTMLImageElement>((resolve, reject) => {
		const candidate = new Image();
		candidate.onerror = () => reject(new Error('Файл не удалось открыть как изображение.'));
		candidate.onload = () => resolve(candidate);
		candidate.src = source;
	});
	for (const maxPx of [1400, 1200, 1000]) {
		const scale = Math.min(1, maxPx / Math.max(image.width, image.height));
		const width = Math.max(1, Math.round(image.width * scale));
		const height = Math.max(1, Math.round(image.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Браузер не смог подготовить фото.');
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, width, height);
		context.drawImage(image, 0, 0, width, height);
		for (const quality of [0.82, 0.72, 0.62, 0.52]) {
			const previewUrl = canvas.toDataURL('image/jpeg', quality);
			const content = previewUrl.replace(/^data:[^,]*,/u, '');
			const size = base64Bytes(content);
			if (size <= 760 * 1024) {
				const stem = file.name.replace(/\.[^.]+$/u, '').trim() || 'product';
				return { fileName: `${stem}.jpg`, mimeType: 'image/jpeg', content, previewUrl, size };
			}
		}
	}
	throw new Error('Фото не удалось уменьшить до безопасного размера 760 КБ.');
}
