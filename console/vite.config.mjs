import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
export default defineConfig({ base: '/console/', resolve: { alias: { '@': fileURLToPath(new URL('./src/vendor/cpamp', import.meta.url)) } }, build: { outDir: 'dist' }, server: { proxy: { '/api': 'http://127.0.0.1:8787' } } })
