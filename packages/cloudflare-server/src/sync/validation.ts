import { z } from 'zod';
import { ApiError, badRequest } from '../lib/errors';
import { LIMITS } from '../lib/limits';
import type { PushedDocumentVersion } from '../db/documents';

const pushedVersionSchema = z.object({
  collection: z.string().min(1).max(256),
  id: z.string().min(1).max(256),
  hlc: z.string().min(1).max(64),
  data: z.string().min(1),
});
const pushBodySchema = z.object({ documents: z.array(pushedVersionSchema) });

export function parsePushBody(body: unknown, maxDocuments: number): PushedDocumentVersion[] {
  const count = (body as { documents?: unknown[] } | null)?.documents?.length ?? 0;
  if (count > maxDocuments) {
    throw new ApiError(
      413,
      'too_many_documents',
      `A push may hold at most ${maxDocuments} documents`
    );
  }
  const parsed = pushBodySchema.safeParse(body);
  if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
  for (const version of parsed.data.documents) {
    if (new TextEncoder().encode(version.data).byteLength > LIMITS.dataBytes) {
      throw new ApiError(413, 'document_too_large', 'A document may hold at most 1 MB of data');
    }
  }
  return parsed.data.documents;
}

const cursorSchema = z.coerce.number().int().nonnegative();

export function parseCursor(raw: string | undefined): number {
  const parsed = cursorSchema.safeParse(raw);
  if (raw === undefined || !parsed.success)
    throw badRequest('cursor must be a non-negative integer');
  return parsed.data;
}

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export function parseHash(raw: string): string {
  const parsed = hashSchema.safeParse(raw);
  if (!parsed.success) throw badRequest('hash must be a lowercase SHA-256 hex digest');
  return parsed.data;
}
