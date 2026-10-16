import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['test/setup.ts'],
      poolOptions: {
        workers: {
          // The AI binding would otherwise open a remote proxy session, which needs a Cloudflare
          // login; tests stub it instead.
          remoteBindings: false,
          // Isolated storage trips over R2's SQLite WAL files when it pops a frame, so tests
          // share one runtime and reset storage themselves (test/setup.ts).
          isolatedStorage: false,
          singleWorker: true,
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              TURNSTILE_SECRET: 'test-secret',
              ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
              ACCESS_AUD: 'aud-123',
            },
          },
        },
      },
    },
  };
});
