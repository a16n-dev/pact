import { defineConfig } from 'vitepress';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('..', import.meta.url));

/** All source Markdown files, relative to srcDir (excludes build/output dirs). */
function sourceMarkdownFiles(): string[] {
  return (fs.readdirSync(srcDir, { recursive: true }) as string[]).filter(
    (f) =>
      f.endsWith('.md') &&
      !f.startsWith('.vitepress') &&
      !f.includes('node_modules')
  );
}

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Pact',
  description:
    'A local-first client/server framework for small, high-trust groups of people and agents collaborating in real time.',
  cleanUrls: true,
  lastUpdated: true,

  // Copy raw Markdown into the build output so each page's "For LLMs" button
  // (see theme/Layout.vue) can link to its own source, e.g. /guide/intro.md.
  buildEnd(siteConfig) {
    for (const rel of sourceMarkdownFiles()) {
      const dest = path.join(siteConfig.outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(srcDir, rel), dest);
    }
  },

  // Serve the same raw Markdown in `vitepress dev` (the build copy doesn't
  // exist yet), so the "For LLMs" link works while developing too.
  vite: {
    plugins: [
      {
        name: 'pact-raw-markdown',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = req.url?.split('?')[0] ?? '';
            if (!url.endsWith('.md')) return next();
            // VitePress loads each page's .md as a JS module in dev. Only
            // intercept real navigations (clicking the "For LLMs" link) and
            // let Vite serve its internal module requests untouched.
            if (req.headers['sec-fetch-dest'] !== 'document') return next();
            const fp = path.join(srcDir, decodeURIComponent(url));
            if (!fp.startsWith(srcDir) || !fs.existsSync(fp)) return next();
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            res.end(fs.readFileSync(fp));
          });
        },
      },
    ],
  },

  head: [
    ['meta', { name: 'theme-color', content: '#3c7d5a' }],
    ['meta', { name: 'og:type', content: 'website' }],
    ['meta', { name: 'og:title', content: 'Pact' }],
    [
      'meta',
      {
        name: 'og:description',
        content: 'Local-first document sync for people and agents.',
      },
    ],
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Guide', link: '/guide/introduction', activeMatch: '/(guide|server)/' },
      { text: 'Reference', link: '/reference/http-api', activeMatch: '/reference/' },
    ],

    // One unified sidebar across every docs page, so Server and Reference read
    // as sections of a single guide rather than disconnected top-level areas.
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Concepts', link: '/guide/concepts' },
          { text: 'The Document Model', link: '/guide/document-model' },
        ],
      },
      {
        text: 'Building a Client',
        items: [
          { text: 'Client Setup', link: '/guide/client-setup' },
          { text: 'Blobs', link: '/guide/blobs' },
          { text: 'Seeds', link: '/guide/seeds' },
          { text: 'Migrations', link: '/guide/migrations' },
          { text: 'Backups', link: '/guide/backups' },
        ],
      },
      {
        text: 'Sync',
        items: [
          { text: 'Sync Protocol', link: '/guide/sync' },
          { text: 'Realtime', link: '/guide/realtime' },
          { text: 'Encryption (E2E)', link: '/guide/encryption' },
        ],
      },
      {
        text: 'Adding a Server',
        items: [
          { text: 'Deployment (Cloudflare)', link: '/server/deployment' },
          { text: 'Authentication', link: '/server/auth' },
          { text: 'Authors & Identity', link: '/guide/authors-identity' },
          { text: 'Agents & MCP', link: '/server/mcp' },
          { text: 'Building Blocks', link: '/server/building-blocks' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'HTTP API', link: '/reference/http-api' },
          { text: 'D1 Schema', link: '/reference/schema' },
          { text: 'Programmatic API', link: '/reference/programmatic-api' },
        ],
      },
    ],

    search: {
      provider: 'local',
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/' }],

    editLink: {
      pattern: 'https://github.com/',
      text: 'Edit this page',
    },

    footer: {
      message: 'Trades generality for simplicity.',
      copyright: 'Pact — local-first sync for people and agents.',
    },
  },
});
