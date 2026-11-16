import type { Store } from '../src/store';
import type { FakeServer } from './fakeServer';

export async function signIn(store: Store<any>, server: FakeServer, deviceName: string) {
  const begun = await store.sync.beginSignIn({
    url: server.origin,
    appId: 'app',
    deviceName,
    redirectUri: 'https://app.test/callback',
  });
  const redirect = server.authorize(begun.authorizeUrl, { username: 'alice', password: 'pw' });
  if ('error' in redirect) throw new Error(redirect.error);
  const result = await store.sync.completeSignIn(redirect);
  if (!result.ok) throw new Error(`Sign-in failed: ${result.reason}`);
}
