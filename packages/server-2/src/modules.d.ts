// Wrangler bundles *.css as Text modules (see `rules` in wrangler.jsonc); vitest does the same
// through `modulesRules` in vitest.config.ts.
declare module '*.css' {
  const css: string;
  export default css;
}
