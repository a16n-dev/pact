import type { RealtimeDO } from '../realtime/durableObject';

export type Env = {
  DB: D1Database;
  BLOBS: R2Bucket;
  REALTIME: DurableObjectNamespace<RealtimeDO>;
  LOGIN_LIMITER: RateLimit;
  AI: Ai;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  MAX_PUSH_DOCUMENTS?: string;
};

const DEFAULT_MAX_PUSH_DOCUMENTS = 50;

export function maxPushDocuments(env: Env): number {
  const parsed = Number(env.MAX_PUSH_DOCUMENTS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PUSH_DOCUMENTS;
}
