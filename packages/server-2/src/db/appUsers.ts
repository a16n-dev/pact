// The allow list consulted at sign-in while an app is restricted.
export type AppUser = { id: string; username: string };

export async function listAppUsers(db: D1Database, appId: string): Promise<AppUser[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.username FROM app_users au JOIN users u ON u.id = au.user_id
       WHERE au.app_id = ?1 ORDER BY u.username`
    )
    .bind(appId)
    .all<AppUser>();
  return results;
}

export async function hasAppAccess(
  db: D1Database,
  appId: string,
  userId: string
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM app_users WHERE app_id = ?1 AND user_id = ?2')
    .bind(appId, userId)
    .first();
  return row !== null;
}

export async function addAppUser(db: D1Database, appId: string, userId: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO app_users (app_id, user_id) VALUES (?1, ?2)')
    .bind(appId, userId)
    .run();
}

// Removing a user also revokes their device tokens for the app so the change takes effect at
// once. Returns the revoked token IDs so their sockets can be closed.
export async function removeAppUser(
  db: D1Database,
  appId: string,
  userId: string
): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM tokens WHERE app_id = ?1 AND user_id = ?2')
    .bind(appId, userId)
    .all<{ id: string }>();
  await db.batch([
    db.prepare('DELETE FROM app_users WHERE app_id = ?1 AND user_id = ?2').bind(appId, userId),
    db.prepare('DELETE FROM tokens WHERE app_id = ?1 AND user_id = ?2').bind(appId, userId),
  ]);
  return results.map((row) => row.id);
}

// Turning restriction on starts the list from everyone currently signed in, so nobody is
// locked out until the admin removes them.
export async function setRestricted(
  db: D1Database,
  appId: string,
  restricted: boolean
): Promise<void> {
  const statements = [
    db.prepare('UPDATE apps SET restricted = ?2 WHERE id = ?1').bind(appId, restricted ? 1 : 0),
  ];
  if (restricted) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO app_users (app_id, user_id)
           SELECT DISTINCT app_id, user_id FROM tokens WHERE app_id = ?1 AND user_id IS NOT NULL`
        )
        .bind(appId)
    );
  }
  await db.batch(statements);
}
