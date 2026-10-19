import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'yjs/index': 'src/yjs/index.ts' },
  format: ['esm'],
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
  clean: true,
  external: ['yjs'],
});
