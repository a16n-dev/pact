import { createSyncApp } from './index';

// Durable Object class for realtime fan-out — must be exported from the
// Worker entry so the REALTIME binding in wrangler.jsonc can find it.
export { RealtimeDO } from './realtime';

// The Worker entry. This is a reference deployment, not a published package:
// fork it, wire up your platform's bindings in wrangler.jsonc, and edit the
// modules under src/ directly. `createSyncApp` takes optional hooks/info if
// you need to customize (see its options), but the bare call is the whole
// server.
export default createSyncApp();
