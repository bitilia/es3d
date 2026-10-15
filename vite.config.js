import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import site from './docs/site/vite-plugin-site.js';
import { PAGES } from './docs/site/pages.js';

const project = fileURLToPath(new URL('.', import.meta.url));
const root = path.join(project, 'docs');

// Each public page is a folder with index.html, so the URL has no .html.
// The home page stays docs/index.html. The pages are listed once, in
// docs/site/pages.js, which also gives the sitemap and the link previews.
// `base: './'` keeps every URL relative, so one build works at a domain
// root, in a subfolder (a GitHub Pages project site), or from a local folder.

export default defineConfig({
  root,
  base: './',
  publicDir: 'public',
  appType: 'mpa',
  plugins: [site()],
  server: {
    port: 5173,
    open: false,
    fs: { allow: [project] },
  },
  preview: { port: 4173 },
  build: {
    outDir: path.join(project, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    // three.js, the benchmark's reference engine, is loaded on demand and is
    // larger than Vite's default warning size (500 kB); no ES3D page loads it
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      input: Object.fromEntries(PAGES.map(({ file }) => [file.replace(/\.html$/, ''), path.join(root, file)])),
    },
  },
});
