import { beforeEach } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const TABLES = [
  'documents',
  'blobs',
  'tokens',
  'auth_codes',
  'app_redirect_uris',
  'app_users',
  'apps',
  'users',
];

beforeEach(async () => {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  const { objects } = await env.BLOBS.list();
  if (objects.length > 0) await env.BLOBS.delete(objects.map((object) => object.key));
});
