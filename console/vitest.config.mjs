import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({ resolve: { alias: { '@': fileURLToPath(new URL('./src/vendor/cpamp', import.meta.url)) } }, test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.tsx'] } })
