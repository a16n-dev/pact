import { type Context, Hono } from 'hono';
import type { Env } from '../lib/env';
import { requireAdminAccess } from './access';
import {
  addOrigin,
  addRedirectUri,
  createApp,
  deleteAppStatements,
  getApp,
  listApps,
  listOrigins,
  listRedirectUris,
  removeOrigin,
  removeRedirectUri,
  renameApp,
  setAiProxy,
  setAllowLocalhost,
  type AppRow,
} from '../db/apps';
import { createUser, deleteUser, listUsers, resetPassword } from '../db/users';
import { addAppUser, listAppUsers, removeAppUser, setRestricted } from '../db/appUsers';
import { deleteToken, listAppTokens, mintApiToken } from '../db/tokens';
import { blobStats, listBlobPage, wipeBlobsStatement } from '../db/blobs';
import {
  collectionStats,
  documentStats,
  listDocumentPage,
  listLabelledVersions,
  wipeDocumentsStatement,
} from '../db/documents';
import { isAllowedRedirectUriForm, isLoopbackUri, parseHttpsOrigin } from '../auth/redirectUris';
import { isValidAppId, isValidLabel, isValidPassword, isValidUsername } from '../lib/validation';
import { notifyRealtime } from '../realtime/durableObject';
import { AppsPage } from './AppsPage';
import { UsersPage } from './UsersPage';
import { BlobsPage } from './BlobsPage';
import { DocumentsPage } from './DocumentsPage';
import { CollectionPage } from './CollectionPage';
import { DocumentPage } from './DocumentPage';
import { AccessPage } from './AccessPage';
import { SettingsPage, type SettingsDialogId } from './SettingsPage';

type AdminEnv = { Bindings: Env; Variables: { app: AppRow } };

export const adminRoutes = new Hono<AdminEnv>();

adminRoutes.use('*', requireAdminAccess);

function field(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === 'string' ? value.trim() : '';
}

adminRoutes.get('/', (c) => c.redirect('/admin/apps'));

adminRoutes.get('/apps', async (c) => {
  return c.html(<AppsPage apps={await listApps(c.env.DB)} />);
});

adminRoutes.post('/apps', async (c) => {
  const form = await c.req.parseBody();
  const name = field(form, 'name');
  const id = field(form, 'id');
  const fail = (error: string) =>
    c.html(<AppsPage apps={[]} dialog={{ open: true, name, id, error }} />, 400);
  if (!isValidLabel(name)) return fail('Give the app a name of up to 100 characters.');
  if (!isValidAppId(id)) {
    return fail('Use lowercase letters, numbers, hyphens and underscores, up to 64 characters.');
  }
  const { created } = await createApp(c.env.DB, id, name);
  if (!created) return fail('An app with this ID already exists.');
  return c.redirect(`/admin/apps/${id}/settings`, 303);
});

adminRoutes.get('/users', async (c) => {
  return c.html(<UsersPage users={await listUsers(c.env.DB)} />);
});

adminRoutes.post('/users', async (c) => {
  const form = await c.req.parseBody();
  const username = field(form, 'username');
  const password = typeof form.password === 'string' ? form.password : '';
  const fail = async (error: string) =>
    c.html(
      <UsersPage users={await listUsers(c.env.DB)} dialog={{ id: 'new-user', username, error }} />,
      400
    );
  if (!isValidUsername(username)) return fail('Usernames are 1 to 64 characters.');
  if (!isValidPassword(password)) return fail('Passwords need at least 8 characters.');
  const { created } = await createUser(c.env.DB, username, password);
  if (!created) return fail('Someone already has this username.');
  return c.redirect('/admin/users', 303);
});

adminRoutes.post('/users/:id/password', async (c) => {
  const userId = c.req.param('id');
  const form = await c.req.parseBody();
  const password = typeof form.password === 'string' ? form.password : '';
  if (!isValidPassword(password)) {
    return c.html(
      <UsersPage
        users={await listUsers(c.env.DB)}
        dialog={{ id: `reset-${userId}`, error: 'Passwords need at least 8 characters.' }}
      />,
      400
    );
  }
  await resetPassword(c.env.DB, userId, password);
  return c.redirect('/admin/users', 303);
});

adminRoutes.post('/users/:id/delete', async (c) => {
  const tokenIds = await deleteUser(c.env.DB, c.req.param('id'));
  c.executionCtx.waitUntil(closeSockets(c.env, tokenIds));
  return c.redirect('/admin/users', 303);
});

// Revoked tokens' sockets live in their app's DO; look each token's app up before deleting.
async function closeSockets(env: Env, tokenIds: string[]): Promise<void> {
  if (tokenIds.length === 0) return;
  const { results } = await env.DB.prepare(
    `SELECT id, app_id FROM tokens WHERE id IN (SELECT value FROM json_each(?1))`
  )
    .bind(JSON.stringify(tokenIds))
    .all<{ id: string; app_id: string }>();
  await Promise.all(
    results.map((row) => notifyRealtime(env, row.app_id, (rt) => rt.closeToken(row.id)))
  );
}

adminRoutes.use('/apps/:id/*', async (c, next) => {
  const app = await getApp(c.env.DB, c.req.param('id'));
  if (!app) return c.text('No app with that ID.', 404);
  c.set('app', app);
  await next();
});

adminRoutes.get('/apps/:id', (c) => c.redirect(`/admin/apps/${c.req.param('id')}/documents`));

adminRoutes.get('/apps/:id/documents', async (c) => {
  const app = c.get('app');
  return c.html(<DocumentsPage app={app} stats={await documentStats(c.env.DB, app.id)} />);
});

adminRoutes.get('/apps/:id/documents/:collection', async (c) => {
  const app = c.get('app');
  const collection = c.req.param('collection');
  const [{ documents, hasMore }, stats] = await Promise.all([
    listDocumentPage(c.env.DB, app.id, collection, c.req.query('after') ?? ''),
    collectionStats(c.env.DB, app.id, collection),
  ]);
  if (stats.document_count === 0) return c.text('No collection with that name.', 404);
  return c.html(
    <CollectionPage
      app={app}
      collection={collection}
      stats={stats}
      documents={documents}
      nextCursor={hasMore ? documents.at(-1)?.id : undefined}
    />
  );
});

adminRoutes.get('/apps/:id/documents/:collection/:docId', async (c) => {
  const app = c.get('app');
  const collection = c.req.param('collection');
  const id = c.req.param('docId');
  const versions = await listLabelledVersions(c.env.DB, app.id, collection, id);
  if (versions.length === 0) return c.text('No document with that ID.', 404);
  return c.html(<DocumentPage app={app} collection={collection} id={id} versions={versions} />);
});

adminRoutes.get('/apps/:id/blobs', async (c) => {
  const app = c.get('app');
  const after = c.req.query('after') ?? '';
  const [{ blobs, hasMore }, stats] = await Promise.all([
    listBlobPage(c.env.DB, app.id, after),
    blobStats(c.env.DB, app.id),
  ]);
  return c.html(
    <BlobsPage
      app={app}
      blobs={blobs}
      stats={stats}
      nextCursor={hasMore ? blobs.at(-1)?.hash : undefined}
    />
  );
});

adminRoutes.get('/apps/:id/blobs/:hash', async (c) => {
  const object = await c.env.BLOBS.get(`${c.get('app').id}/${c.req.param('hash')}`);
  if (!object) return c.text('No blob with that hash.', 404);
  return c.body(object.body, 200, {
    'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'content-disposition': `attachment; filename="${c.req.param('hash')}"`,
  });
});

async function accessPage(
  c: Context<AdminEnv>,
  extra: {
    addUser?: { error: string };
    mint?: { open: boolean; label?: string; error?: string };
    minted?: { label: string; token: string };
  } = {}
) {
  const app = c.get('app');
  const [allowed, users, { api, devices }] = await Promise.all([
    listAppUsers(c.env.DB, app.id),
    listUsers(c.env.DB),
    listAppTokens(c.env.DB, app.id),
  ]);
  return (
    <AccessPage app={app} allowed={allowed} users={users} api={api} devices={devices} {...extra} />
  );
}

adminRoutes.get('/apps/:id/access', async (c) => c.html(await accessPage(c)));

adminRoutes.post('/apps/:id/access/restrict', async (c) => {
  const app = c.get('app');
  await setRestricted(c.env.DB, app.id, field(await c.req.parseBody(), 'enabled') === 'on');
  return c.redirect(`/admin/apps/${app.id}/access`, 303);
});

adminRoutes.post('/apps/:id/access/users', async (c) => {
  const app = c.get('app');
  const userId = field(await c.req.parseBody(), 'user_id');
  const users = await listUsers(c.env.DB);
  if (!users.some((user) => user.id === userId)) {
    return c.html(
      await accessPage(c, { addUser: { error: 'Choose a user on this server.' } }),
      400
    );
  }
  await addAppUser(c.env.DB, app.id, userId);
  return c.redirect(`/admin/apps/${app.id}/access`, 303);
});

adminRoutes.post('/apps/:id/access/users/remove', async (c) => {
  const app = c.get('app');
  const tokenIds = await removeAppUser(c.env.DB, app.id, field(await c.req.parseBody(), 'user_id'));
  c.executionCtx.waitUntil(
    Promise.all(tokenIds.map((id) => notifyRealtime(c.env, app.id, (rt) => rt.closeToken(id))))
  );
  return c.redirect(`/admin/apps/${app.id}/access`, 303);
});

adminRoutes.post('/apps/:id/access/tokens', async (c) => {
  const label = field(await c.req.parseBody(), 'label');
  if (!isValidLabel(label)) {
    return c.html(
      await accessPage(c, {
        mint: { open: true, label, error: 'Give the token a label of up to 100 characters.' },
      }),
      400
    );
  }
  const { token } = await mintApiToken(c.env.DB, c.get('app').id, label);
  return c.html(await accessPage(c, { minted: { label, token } }));
});

adminRoutes.post('/apps/:id/access/tokens/:tokenId/revoke', async (c) => {
  const app = c.get('app');
  const tokenId = c.req.param('tokenId');
  await deleteToken(c.env.DB, app.id, tokenId);
  c.executionCtx.waitUntil(notifyRealtime(c.env, app.id, (rt) => rt.closeToken(tokenId)));
  return c.redirect(`/admin/apps/${app.id}/access`, 303);
});

async function settingsPage(
  c: Context<AdminEnv>,
  dialog?: { id: SettingsDialogId; value?: string; error?: string }
) {
  const app = c.get('app');
  const [redirectUris, origins, stats, documents, tokens] = await Promise.all([
    listRedirectUris(c.env.DB, app.id),
    listOrigins(c.env.DB, app.id),
    blobStats(c.env.DB, app.id),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM documents WHERE app_id = ?1')
      .bind(app.id)
      .first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM tokens WHERE app_id = ?1')
      .bind(app.id)
      .first<{ n: number }>(),
  ]);
  return (
    <SettingsPage
      app={app}
      redirectUris={redirectUris}
      origins={origins}
      counts={{
        documents: documents?.n ?? 0,
        blobs: stats.count,
        blobBytes: stats.bytes,
        tokens: tokens?.n ?? 0,
      }}
      dialog={dialog}
    />
  );
}

adminRoutes.get('/apps/:id/settings', async (c) => c.html(await settingsPage(c)));

adminRoutes.post('/apps/:id/rename', async (c) => {
  const app = c.get('app');
  const name = field(await c.req.parseBody(), 'name');
  if (!isValidLabel(name)) {
    return c.html(
      await settingsPage(c, {
        id: 'rename',
        value: name,
        error: 'Give the app a name of up to 100 characters.',
      }),
      400
    );
  }
  await renameApp(c.env.DB, app.id, name);
  return c.redirect(`/admin/apps/${app.id}/settings`, 303);
});

adminRoutes.post('/apps/:id/redirect-uris', async (c) => {
  const app = c.get('app');
  const uri = field(await c.req.parseBody(), 'uri');
  const fail = async (error: string) =>
    c.html(await settingsPage(c, { id: 'add-uri', value: uri, error }), 400);
  if (isLoopbackUri(uri)) {
    return fail('Turn on "Allow localhost" instead; it covers every localhost address and port.');
  }
  if (!uri || uri.length > 2048 || !isAllowedRedirectUriForm(uri)) {
    return fail('Use an https address or a custom scheme like com.example.app:/callback.');
  }
  await addRedirectUri(c.env.DB, app.id, uri);
  const origin = parseHttpsOrigin(uri);
  if (origin) await addOrigin(c.env.DB, app.id, origin);
  return c.redirect(`/admin/apps/${app.id}/settings`, 303);
});

adminRoutes.post('/apps/:id/origins', async (c) => {
  const app = c.get('app');
  const domain = field(await c.req.parseBody(), 'domain');
  const origin = domain.length <= 2048 ? parseHttpsOrigin(domain) : null;
  if (!origin) {
    return c.html(
      await settingsPage(c, {
        id: 'add-origin',
        value: domain,
        error: 'Use a domain served over https, like app.example.com.',
      }),
      400
    );
  }
  await addOrigin(c.env.DB, app.id, origin);
  return c.redirect(`/admin/apps/${app.id}/settings`, 303);
});

adminRoutes.post('/apps/:id/origins/remove', async (c) => {
  const app = c.get('app');
  await removeOrigin(c.env.DB, app.id, field(await c.req.parseBody(), 'origin'));
  return c.redirect(`/admin/apps/${app.id}/settings`, 303);
});

adminRoutes.post('/apps/:id/localhost', async (c) => {
  const app = c.get('app');
  await setAllowLocalhost(c.env.DB, app.id, field(await c.req.parseBody(), 'enabled') === 'on');
  return c.redirect(`/admin/apps/${app.id}/settings`, 303);
});

adminRoutes.post('/apps/:id/ai-proxy', async (c) => {
  const app = c.get('app');
  await setAiProxy(c.env.DB, app.id, field(await c.req.parseBody(), 'enabled') === 'on');
  return c.redirect(`/admin/apps/${app.id}/settings`, 303);
});

adminRoutes.post('/apps/:id/redirect-uris/remove', async (c) => {
  const app = c.get('app');
  await removeRedirectUri(c.env.DB, app.id, field(await c.req.parseBody(), 'uri'));
  return c.redirect(`/admin/apps/${app.id}/settings`, 303);
});

async function deleteAppBlobs(bucket: R2Bucket, appId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${appId}/`, cursor });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

adminRoutes.post('/apps/:id/wipe', async (c) => {
  const app = c.get('app');
  await c.env.DB.batch([
    wipeDocumentsStatement(c.env.DB, app.id),
    wipeBlobsStatement(c.env.DB, app.id),
  ]);
  await deleteAppBlobs(c.env.BLOBS, app.id);
  return c.redirect(`/admin/apps/${app.id}/settings`, 303);
});

adminRoutes.post('/apps/:id/delete', async (c) => {
  const app = c.get('app');
  if (field(await c.req.parseBody(), 'confirm') !== app.id) {
    return c.html(
      await settingsPage(c, { id: 'delete', error: `Type ${app.id} exactly to delete the app.` }),
      400
    );
  }
  const { results } = await c.env.DB.prepare('SELECT id FROM tokens WHERE app_id = ?1')
    .bind(app.id)
    .all<{ id: string }>();
  await c.env.DB.batch(deleteAppStatements(c.env.DB, app.id));
  await deleteAppBlobs(c.env.BLOBS, app.id);
  c.executionCtx.waitUntil(
    Promise.all(results.map((row) => notifyRealtime(c.env, app.id, (rt) => rt.closeToken(row.id))))
  );
  return c.redirect('/admin/apps', 303);
});
