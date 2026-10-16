import { createSyncApp } from './index';

// The REALTIME binding in wrangler.jsonc resolves the DO class from the Worker entry.
export { RealtimeDO } from './realtime';

export default createSyncApp();
