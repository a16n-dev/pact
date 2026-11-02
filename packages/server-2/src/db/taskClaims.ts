import { LIMITS } from '../lib/limits';

export type ClaimResult = { claimed: boolean; expiresAt: number };

// Revs are HLC strings, so plain string comparison orders them. A newer rev takes the claim at
// once because its input replaced the older run's; an older rev never takes it back.
export async function claimTask(
  db: D1Database,
  appId: string,
  writerId: string,
  taskId: string,
  rev: string
): Promise<ClaimResult> {
  const now = Date.now();
  const [, select] = await db.batch<{ rev: string; writer_id: string; expires_at: number }>([
    db
      .prepare(
        `INSERT INTO task_claims (app_id, task_id, rev, writer_id, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (app_id, task_id) DO UPDATE
           SET rev = excluded.rev, writer_id = excluded.writer_id, expires_at = excluded.expires_at
           WHERE excluded.rev > task_claims.rev
              OR (excluded.rev = task_claims.rev
                  AND (task_claims.writer_id = excluded.writer_id OR task_claims.expires_at <= ?6))`
      )
      .bind(appId, taskId, rev, writerId, now + LIMITS.taskClaimTtlMs, now),
    db
      .prepare(
        'SELECT rev, writer_id, expires_at FROM task_claims WHERE app_id = ?1 AND task_id = ?2'
      )
      .bind(appId, taskId),
  ]);
  const row = select!.results[0]!;
  return { claimed: row.rev === rev && row.writer_id === writerId, expiresAt: row.expires_at };
}

export async function releaseTask(
  db: D1Database,
  appId: string,
  writerId: string,
  taskId: string,
  rev: string
): Promise<void> {
  await db
    .prepare(
      'DELETE FROM task_claims WHERE app_id = ?1 AND task_id = ?2 AND rev = ?3 AND writer_id = ?4'
    )
    .bind(appId, taskId, rev, writerId)
    .run();
}

export function wipeTaskClaimsStatement(db: D1Database, appId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM task_claims WHERE app_id = ?1').bind(appId);
}
