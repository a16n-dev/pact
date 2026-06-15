import { Hono } from 'hono';
import type { OAuthHelpers, AuthRequest } from '@cloudflare/workers-oauth-provider';
import { registerClient, timingSafeEqual } from './auth';
import type { Env } from '../types';
import { escapeHtml } from '../landing/html';

export interface OAuthAuthBranding {
  /** Page title text. Receives the connecting agent's display name. */
  title: (agentName: string) => string;
  /** One-line subtitle under the title. */
  subtitle: string;
  /** Fallback agent name when the OAuth client hasn't declared one. */
  fallbackAgentName?: string;
}

export interface AuthIdentity {
  /** Newly-minted sync-client row: id + display name. */
  client: { id: string; name: string };
  /** OAuth completion payload — userId and consumer-defined props. */
  oauth: { userId: string; props: Record<string, unknown> };
}

export interface OAuthAuthOptions {
  branding: OAuthAuthBranding;
  /**
   * Mint the sync-client + OAuth identity for a freshly-authenticated agent.
   * Called once per successful authorize POST, after the password check
   * passes. Lets the deploy package own its id conventions (e.g. `us/mcp-…`,
   * `cl/…`) and pick the shape of props its agent sees later.
   */
  buildIdentity: (context: { agentName: string }) => AuthIdentity;
}

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

/**
 * OAuth authorization-flow surface. The deploy package mounts this inside
 * its `OAuthProvider.defaultHandler` — every `/authorize` GET+POST request
 * routes here.
 *
 *   GET  /authorize  — render a connect-this-agent form
 *   POST /authorize  — validate the server password, register a client row,
 *                      complete the OAuth grant via `buildIdentity`
 */
export function createOAuthAuthApp(opts: OAuthAuthOptions): Hono<{ Bindings: AuthEnv }> {
  const app = new Hono<{ Bindings: AuthEnv }>();
  const fallback = opts.branding.fallbackAgentName ?? 'Agent';

  app.get('/authorize', async (c) => {
    const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
    const agentName = client?.clientName?.trim() || fallback;
    const encoded = encodeURIComponent(JSON.stringify(oauthReqInfo));
    return c.html(
      formHtml({
        branding: opts.branding,
        agentName,
        oauthReqEncoded: encoded,
        error: null,
        logoUri: client?.logoUri ?? null,
      })
    );
  });

  app.post('/authorize', async (c) => {
    const form = await c.req.formData();
    const password = String(form.get('password') ?? '').trim();
    const oauthReqRaw = String(form.get('oauthReqInfo') ?? '');

    let oauthReqInfo: AuthRequest;
    try {
      oauthReqInfo = JSON.parse(decodeURIComponent(oauthReqRaw)) as AuthRequest;
    } catch {
      return c.text('Invalid auth request', 400);
    }

    const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
    const agentName = client?.clientName?.trim() || fallback;
    const logoUri = client?.logoUri ?? null;
    const renderError = (error: string) =>
      c.html(
        formHtml({
          branding: opts.branding,
          agentName,
          oauthReqEncoded: oauthReqRaw,
          error,
          logoUri,
        }),
        400
      );

    if (!password) return renderError('Server password is required.');
    if (!(await timingSafeEqual(password, c.env.API_KEY)))
      return renderError('Incorrect password.');

    const identity = opts.buildIdentity({ agentName });
    await registerClient(c.env.DB, identity.client.id, identity.client.name);

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: identity.oauth.userId,
      scope: oauthReqInfo.scope,
      metadata: {},
      props: identity.oauth.props,
    });

    return Response.redirect(redirectTo, 302);
  });

  return app;
}

interface FormHtmlArgs {
  branding: OAuthAuthBranding;
  agentName: string;
  oauthReqEncoded: string;
  error: string | null;
  logoUri: string | null;
}

function formHtml({ branding, agentName, oauthReqEncoded, error, logoUri }: FormHtmlArgs): string {
  const errorHtml = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  const logoHtml = logoUri
    ? `<img class="logo" src="${escapeHtml(logoUri)}" alt="${escapeHtml(agentName)} logo" />`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Connect</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f5;
    --fg: #1a1a1a;
    --muted: rgba(26, 26, 26, 0.6);
    --hint: rgba(26, 26, 26, 0.5);
    --card-bg: #ffffff;
    --input-bg: #ffffff;
    --input-border: #d4d4d8;
    --input-focus: #1a1a1a;
    --button-bg: #1a1a1a;
    --button-fg: #ffffff;
    --err-bg: #fdecec;
    --err-fg: #9b1c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111;
      --fg: #eee;
      --muted: rgba(238, 238, 238, 0.6);
      --hint: rgba(238, 238, 238, 0.5);
      --card-bg: #1c1c1c;
      --input-bg: #111;
      --input-border: #2f2f2f;
      --input-focus: #eee;
      --button-bg: #eee;
      --button-fg: #111;
      --err-bg: #3a1818;
      --err-fg: #f5a5a5;
    }
  }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
  .card {
    width: 100%;
    max-width: 28rem;
    padding: 1.75rem;
    background: var(--card-bg);
    border-radius: 1rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    box-sizing: border-box;
  }
  .logo {
    display: block;
    width: 48px;
    height: 48px;
    border-radius: 0.5rem;
    object-fit: contain;
    margin: 0 0 1rem;
  }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; font-weight: 600; }
  .sub { margin: 0 0 1.25rem; font-size: 0.9rem; opacity: 0.7; }
  label {
    display: block;
    font-size: 0.75rem;
    font-weight: 500;
    margin-top: 1rem;
    margin-bottom: 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  input {
    width: 100%;
    padding: 0.65rem 0.8rem;
    font-size: 0.95rem;
    font-family: inherit;
    color: var(--fg);
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 0.6rem;
    box-sizing: border-box;
  }
  input:focus {
    outline: 2px solid var(--input-focus);
    outline-offset: -1px;
    border-color: transparent;
  }
  button {
    width: 100%;
    margin-top: 1.5rem;
    padding: 0.75rem;
    font-size: 0.95rem;
    font-weight: 600;
    font-family: inherit;
    color: var(--button-fg);
    background: var(--button-bg);
    border: 0;
    border-radius: 0.6rem;
    cursor: pointer;
  }
  button:hover { opacity: 0.9; }
  .err {
    margin: 1rem 0 0;
    padding: 0.65rem 0.8rem;
    font-size: 0.85rem;
    color: var(--err-fg);
    background: var(--err-bg);
    border-radius: 0.6rem;
  }
</style>
</head>
<body>
  <form class="card" method="POST" action="/authorize">
    ${logoHtml}
    <h1>${escapeHtml(branding.title(agentName))}</h1>
    <p class="sub">${escapeHtml(branding.subtitle)}</p>
    ${errorHtml}
    <input type="hidden" name="oauthReqInfo" value="${oauthReqEncoded}" />

    <label for="password">Server password</label>
    <input id="password" name="password" type="password" autocomplete="off" autofocus required />

    <button type="submit">Connect</button>
  </form>
</body>
</html>`;
}
