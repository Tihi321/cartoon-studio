import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Builds the Canvas player to out/player/ (index.html + assets/): one page, served by the engine at /preview/, embedded in the studio's
// timeline view and loaded by the renderer in headless Chromium. Relative asset URLs (base './'), so it opens from /preview/, file:// and
// the app alike. No code splitting, no CDN: the folder is all there is.
export default defineConfig({
  root: resolve(__dirname, 'src/player'),
  base: './',
  // no public folder: the bundle is all there is
  publicDir: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(__dirname, 'out/player'),
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/player/index.html') },
      output: { inlineDynamicImports: true },
      // zod's /*@__PURE__*/ comments sit where rollup cannot read them: harmless, and not worth a screenful of warnings per build
      onwarn(warning, warn) {
        if (warning.code === 'INVALID_ANNOTATION') return
        warn(warning)
      }
    }
  }
})
