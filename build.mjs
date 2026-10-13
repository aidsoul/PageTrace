// build.mjs — Custom build script for PageTrace extension
// Builds each entry as a separate bundle using Rollup + esbuild minification.
// Usage: node build.mjs [firefox|chrome] [--watch]

import { rollup, watch } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import typescript from '@rollup/plugin-typescript';
import { transform } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const isWatch = args.includes('--watch') || args.includes('-w');
const targetArg = args.find((a) => !a.startsWith('-'));

const targets = targetArg === 'chrome'
  ? ['chrome']
  : targetArg === 'firefox'
  ? ['firefox']
  : ['firefox', 'chrome'];

// Extension entry points
const ENTRIES = [
  { name: 'background', input: 'src/background/index.ts', format: 'es' },
  { name: 'content',    input: 'src/content/index.ts',    format: 'iife' },
  { name: 'overlay',   input: 'src/overlay/index.ts',    format: 'iife' },
  { name: 'options',   input: 'src/options/index.ts',    format: 'iife' },
  { name: 'popup',     input: 'src/popup/index.ts',      format: 'iife' },
  { name: 'search',    input: 'src/search-window/index.ts', format: 'iife' },
];

function esbuildMinifyPlugin() {
  return {
    name: 'esbuild-minify',
    async renderChunk(code) {
      if (isWatch) return null;
      const result = await transform(code, {
        minify: true,
        target: 'es2022',
        legalComments: 'none',
      });
      return {
        code: result.code,
        map: null,
      };
    },
  };
}

// Rollup plugins for target browser
function getPlugins(browser) {
  return [
    replace({
      preventAssignment: true,
      values: {
        '__BROWSER__': JSON.stringify(browser),
        'process.env.NODE_ENV': JSON.stringify('production'),
      },
    }),
    nodeResolve({
      browser: true,
      preferBuiltins: false,
    }),
    commonjs(),
    typescript({
      tsconfig: resolve(__dirname, 'tsconfig.json'),
      compilerOptions: {
        noEmit: false,
        declaration: false,
      },
    }),
    esbuildMinifyPlugin(),
  ];
}

// Build bundle for a specific browser target
async function buildTarget(browser) {
  const outDir = resolve(__dirname, `dist/${browser}`);

  // Clean output dir
  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  for (const entry of ENTRIES) {
    console.log(`\n📦 Building ${entry.name} (${entry.format}) for ${browser}…`);
    const bundle = await rollup({
      input: resolve(__dirname, entry.input),
      plugins: getPlugins(browser),
      onwarn(warning, warn) {
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        if (warning.code === 'THIS_IS_UNDEFINED') return;
        warn(warning);
      },
    });

    await bundle.write({
      file: resolve(outDir, `${entry.name}.js`),
      format: entry.format,
      name: entry.name === 'background' ? undefined : `PT_${entry.name}`,
      inlineDynamicImports: true,
      sourcemap: false,
    });

    await bundle.close();
    console.log(`   ✓ dist/${browser}/${entry.name}.js`);
  }

  // Copy manifest
  const manifestSrc = resolve(__dirname, `manifests/manifest.${browser}.json`);
  if (existsSync(manifestSrc)) {
    copyFileSync(manifestSrc, resolve(outDir, 'manifest.json'));
    console.log(`\n✓ manifest.json copied`);
  }

  // Copy icons
  const iconsSrc = resolve(__dirname, 'icons');
  const iconsDest = resolve(outDir, 'icons');
  mkdirSync(iconsDest, { recursive: true });
  if (existsSync(iconsSrc)) {
    readdirSync(iconsSrc).forEach((f) => {
      copyFileSync(resolve(iconsSrc, f), resolve(iconsDest, f));
    });
    console.log(`✓ icons/ copied`);
  }

  // Copy HTML pages
  [
    ['src/options/options.html', 'options.html'],
    ['src/popup/popup.html', 'popup.html'],
    ['src/search-window/search.html', 'search.html'],
  ].forEach(([src, dest]) => {
    const srcPath = resolve(__dirname, src);
    if (existsSync(srcPath)) {
      copyFileSync(srcPath, resolve(outDir, dest));
      console.log(`✓ ${dest} copied`);
    }
  });

  console.log(`\n🎉 Build complete → dist/${browser}/\n`);
}

async function buildAll() {
  for (const target of targets) {
    await buildTarget(target);
  }

  if (isWatch) {
    const watchTarget = targets[0];
    const outDir = resolve(__dirname, `dist/${watchTarget}`);
    console.log(`\n👀 Watching for changes (${watchTarget})…`);
    const watchConfigs = ENTRIES.map((entry) => ({
      input: resolve(__dirname, entry.input),
      plugins: getPlugins(watchTarget),
      output: {
        file: resolve(outDir, `${entry.name}.js`),
        format: entry.format,
        name: entry.name === 'background' ? undefined : `PT_${entry.name}`,
        inlineDynamicImports: true,
        sourcemap: false,
      },
      onwarn(warning, warn) {
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        if (warning.code === 'THIS_IS_UNDEFINED') return;
        warn(warning);
      },
    }));
    const watcher = watch(watchConfigs);
    watcher.on('event', (event) => {
      if (event.code === 'BUNDLE_END') {
        event.result.close();
      } else if (event.code === 'END') {
        console.log(`✓ Rebuilt (${watchTarget}) at ${new Date().toLocaleTimeString()}`);
      } else if (event.code === 'ERROR') {
        console.error('Watch build error:', event.error);
      }
    });
  }
}

buildAll().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
