export interface SyncDocument {
  id: string;
  collection: string;
  updatedAt: string;
  data: unknown;
}

// Authoritative record that a blob exists; the bytes live in R2 under `hash`.
export interface BlobRecord {
  hash: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface PushRequest {
  documents: SyncDocument[];
}

export interface PullResponse {
  documents: SyncDocument[];
  // Server `seq` high-water mark; the client persists it as its next cursor.
  cursor: number;
  hasMore: boolean;
}

import type { RealtimeDO } from './realtime';

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  // Guards `POST /apps`, the only way an app comes into existence. Unset
  // disables the route.
  PROVISION_KEY?: string;
  SERVER_NAME: string;
  ENABLE_REALTIME: string;
  REALTIME: DurableObjectNamespace<RealtimeDO>;
}
