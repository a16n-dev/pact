import { defineConfig } from 'vitepress';

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Pact',
  description:
    'A local-first client/server framework for small, high-trust groups of people and agents collaborating in real time.',
  cleanUrls: true,
  lastUpdated: true,

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
      { text: 'Guide', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: 'Server', link: '/server/deployment', activeMatch: '/server/' },
      {
        text: 'Reference',
        link: '/reference/http-api',
        activeMatch: '/reference/',
      },
    ],

    sidebar: {
      '/guide/': [
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
            { text: 'Authors & Identity', link: '/guide/authors-identity' },
            { text: 'Migrations', link: '/guide/migrations' },
            { text: 'Backups', link: '/guide/backups' },
          ],
        },
        {
          text: 'Sync',
          items: [
            { text: 'Sync Protocol', link: '/guide/sync' },
            { text: 'Realtime', link: '/guide/realtime' },
            { text: 'Blobs', link: '/guide/blobs' },
            { text: 'Seeds', link: '/guide/seeds' },
          ],
        },
      ],
      '/server/': [
        {
          text: 'Server',
          items: [
            { text: 'Deployment (Cloudflare)', link: '/server/deployment' },
            { text: 'Authentication', link: '/server/auth' },
            { text: 'Agents & MCP', link: '/server/mcp' },
            { text: 'Building Blocks', link: '/server/building-blocks' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'HTTP API', link: '/reference/http-api' },
            { text: 'D1 Schema', link: '/reference/schema' },
            { text: 'Programmatic API', link: '/reference/programmatic-api' },
          ],
        },
      ],
    },

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
