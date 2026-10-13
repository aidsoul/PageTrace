import { defineConfig, build } from 'vite';
import { resolve } from 'path';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';

// Each extension entry needs its own IIFE bundle.
// We do this by building each entry separately in sequence.

const entries = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  overlay: 'src/overlay/index.ts',
  options: 'src/options/index.ts',
  popup: 'src/popup/index.ts',
  search: 'src/search-window/index.ts',
} as const;

export default defineConfig(({ mode }) => {
  const browser = (mode === 'chrome' ? 'chrome' : 'firefox') as 'firefox' | 'chrome';

  return {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    define: {
      __BROWSER__: JSON.stringify(browser),
    },
    build: {
      outDir: `dist/${browser}`,
      emptyOutDir: true,
      sourcemap: false,
      minify: 'esbuild',
      target: 'es2022',
      rollupOptions: {
        input: {
          background: resolve(__dirname, 'src/background/index.ts'),
          content: resolve(__dirname, 'src/content/index.ts'),
          overlay: resolve(__dirname, 'src/overlay/index.ts'),
          options: resolve(__dirname, 'src/options/index.ts'),
          popup: resolve(__dirname, 'src/popup/index.ts'),
          search: resolve(__dirname, 'src/search-window/index.ts'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          format: 'es',
        },
        onwarn(warning, warn) {
          if (warning.code === 'CIRCULAR_DEPENDENCY') return;
          warn(warning);
        },
      },
    },
    plugins: [
      {
        name: 'copy-extension-assets',
        writeBundle() {
          const outDir = resolve(__dirname, `dist/${browser}`);
          if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

          // Copy manifest
          const manifestSrc = resolve(__dirname, `manifests/manifest.${browser}.json`);
          const manifestDest = resolve(outDir, 'manifest.json');
          if (existsSync(manifestSrc)) {
            copyFileSync(manifestSrc, manifestDest);
            console.log(`✓ manifest.${browser}.json → dist/${browser}/manifest.json`);
          }

          // Copy icons
          const iconsSrc = resolve(__dirname, 'icons');
          const iconsDest = resolve(outDir, 'icons');
          if (!existsSync(iconsDest)) mkdirSync(iconsDest, { recursive: true });
          if (existsSync(iconsSrc)) {
            readdirSync(iconsSrc).forEach((f) => {
              copyFileSync(resolve(iconsSrc, f), resolve(iconsDest, f));
            });
            console.log(`✓ icons → dist/${browser}/icons/`);
          }

          // Copy HTML pages
          [
            { src: resolve(__dirname, 'src/options/options.html'), dest: resolve(outDir, 'options.html') },
            { src: resolve(__dirname, 'src/popup/popup.html'), dest: resolve(outDir, 'popup.html') },
            { src: resolve(__dirname, 'src/search-window/search.html'), dest: resolve(outDir, 'search.html') },
          ].forEach(({ src, dest }) => {
            if (existsSync(src)) {
              copyFileSync(src, dest);
              console.log(`✓ ${src.split(/[\\/]/).pop()} → dist/${browser}/`);
            }
          });
        },
      },
    ],
  };
});
