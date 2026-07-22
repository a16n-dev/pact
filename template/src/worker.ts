import { createSyncApp } from '@a16n/pact-server';

// Durable Object class for realtime fan-out — must be exported from the
// Worker entry so the REALTIME binding in wrangler.jsonc can find it.
export { RealtimeDO } from '@a16n/pact-server';

export default createSyncApp();
