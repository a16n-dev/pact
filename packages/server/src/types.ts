export interface SyncDocument {
  id: string;
  collection: string;
  updatedAt: string;
  data: unknown;
}

/**
 * Registry row for a content-addressed blob. The bytes live in R2 keyed by
 * `hash`; this row is the authoritative record that the blob exists, plus
 * metadata (mime/size/createdAt) queryable without fetching the bytes.
 */
export interface BlobRecord {
  hash: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface PushRequest {
  documents: SyncDocument[];
}

export interface PushResponse {
  accepted: number;
  skipped: number;
}

export interface PullResponse {
  documents: SyncDocument[];
  /** Server `seq` high-water mark the client persists as its next pull cursor. */
  cursor: number;
  /** Whether documents beyond this page remain; the client re-pulls while true. */
  hasMore: boolean;
}

import type { RealtimeDO } from './realtime';

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  /**
   * Master key guarding dynamic app provisioning via `POST /apps` (create an
   * app or rotate its password). This is the only way apps come into
   * existence — clients name their app at registration, and everything after
   * that is scoped by the app recorded on their client row. When unset, the
   * route is disabled and no apps can be created.
   */
  PROVISION_KEY?: string;
  SERVER_NAME: string;
  ENABLE_REALTIME: string;
  REALTIME: DurableObjectNamespace<RealtimeDO>;
}
