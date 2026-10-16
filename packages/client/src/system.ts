export const SYSTEM_AUTHOR_ID = '_system';

/**
 * Author id for writes made before the client has claimed an identity on a
 * sync server. The server rejects documents carrying it, so clients must
 * reassign these to a real author before pushing.
 */
export const LOCAL_AUTHOR_ID = '_local';
