export const SYSTEM_AUTHOR_ID = '_system';

/**
 * Placeholder author id for local-only writes — used as `createdBy` /
 * `updatedBy` before the client has claimed a real identity on a sync server.
 * The server rejects any documents tagged with this id; clients must reassign
 * these to a real author before pushing.
 */
export const LOCAL_AUTHOR_ID = '_local';
