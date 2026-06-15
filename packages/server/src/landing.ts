import { Hono } from 'hono';
import qrcode from 'qrcode-generator';
import type { Env } from './types';
import { escapeHtml } from './html';

export interface LandingOptions {
  /**
   * URI scheme for the deep link. Combined with `deepLinkPath` to form
   * `<scheme>://<path>?url=<origin>`. The receiving app registers this scheme
   * to handle "add a server" intents.
   */
  deepLinkScheme: string;
  /** Path segment after the scheme. Defaults to `sync`. */
  deepLinkPath?: string;
  /** App name used in the body copy ("scan to set up sync in <appName>"). */
  appName: string;
}

/**
 * GET / — connection landing page. Renders a QR code holding a
 * `<scheme>://<path>?url=<origin>` deep link plus the raw origin underneath
 * so a user can either scan with their phone or paste the URL into the
 * receiving app's "add server" flow.
 *
 * Returned as its own Hono app so the deploy package mounts it at the URL
 * it wants (typically `/`).
 */
export function createLandingApp(opts: LandingOptions): Hono<{ Bindings: Env }> {
  const path = opts.deepLinkPath ?? 'sync';

  const app = new Hono<{ Bindings: Env }>();

  app.get('/', (c) => {
    const origin = new URL(c.req.url).origin;
    const deepLink = `${opts.deepLinkScheme}://${path}?url=${encodeURIComponent(origin)}`;
    // Render the QR server-side so the page is self-contained: no third-party
    // CDN script at runtime (works offline / under a strict CSP).
    const qr = qrcode(0, 'H');
    qr.addData(deepLink);
    qr.make();
    const qrSvg = qr.createSvgTag({ scalable: true, margin: 0 });
    return c.html(renderHtml(c.env.SERVER_NAME, origin, qrSvg, opts.appName));
  });

  return app;
}

function renderHtml(serverName: string, origin: string, qrSvg: string, appName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Connect to ${escapeHtml(serverName)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    padding: 2rem 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #f7f7f5;
    color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; }
    .card { background: #1c1c1c; }
  }
  h1 { font-size: 1.25rem; margin: 0; font-weight: 600; }
  p { margin: 0; opacity: 0.7; font-size: 0.9rem; text-align: center; max-width: 28rem; }
  .card {
    background: white;
    border-radius: 1rem;
    padding: 1.25rem;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .card svg { display: block; width: 240px; height: 240px; }
  .manual {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    max-width: 28rem;
    width: 100%;
  }
  .manual-divider {
    font-size: 0.8rem;
    opacity: 0.5;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .manual-label {
    font-size: 0.75rem;
    opacity: 0.6;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .manual-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.95rem;
    word-break: break-all;
    text-align: center;
  }
</style>
</head>
<body>
  <h1>Connect to ${escapeHtml(serverName)}</h1>
  <p>Scan this code with your phone's camera to set up sync in ${escapeHtml(appName)}. You'll still need this server's password.</p>
  <div class="card" id="qr">${qrSvg}</div>
  <div class="manual">
    <div class="manual-divider">or enter it manually</div>
    <div class="manual-label">Connection string</div>
    <div class="manual-value">${escapeHtml(origin)}</div>
  </div>
</body>
</html>`;
}
