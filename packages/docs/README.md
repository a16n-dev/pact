# @pact/docs

The Pact documentation site, built with [VitePress](https://vitepress.dev).

## Develop

```bash
pnpm --filter @pact/docs dev      # local dev server with hot reload
pnpm --filter @pact/docs build    # static build → .vitepress/dist
pnpm --filter @pact/docs preview  # preview the production build
```

## Structure

```
packages/docs/
├─ .vitepress/config.ts   # site config: nav, sidebar, theme
├─ index.md               # home page
├─ guide/                 # concepts + client-side guide
├─ server/                # server deployment, auth, MCP, building blocks
└─ reference/             # HTTP API, D1 schema, programmatic API
```

Content is plain Markdown — add a page, then link it into the sidebar in `.vitepress/config.ts`.
