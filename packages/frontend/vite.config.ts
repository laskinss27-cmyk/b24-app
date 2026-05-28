import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		// Битрикс грузит iframe с другого origin — на dev нужны CORS-разрешения
		cors: true,
	},
	build: {
		outDir: 'dist',
		sourcemap: true,
	},
});
