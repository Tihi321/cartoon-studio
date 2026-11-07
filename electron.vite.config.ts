import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // electron-vite does not minify by default
    build: { minify: 'esbuild', rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
    // the dev server may serve the design tokens, fonts and the player's item renderers that live outside src/renderer
    server: { fs: { allow: [resolve(__dirname)] } },
    plugins: [react()]
  }
})
