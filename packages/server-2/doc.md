# Pact 2

A Cloudflare-deployable server that provides opaque document and blob storage for a set of registered apps, plus authentication against a server-wide registry of users. Intended for personal use and small groups of family and friends.

The client-facing contract is in [`api.md`](./api.md); this document is the server design and build spec.

## Out of scope

- Access control: all of an app's data is shared by everyone signed in to it, and any user can sign in to any app.
- Self-signup, invites, user roles.
- Blob deletion and GC.
- Sibling pruning: the server keeps one row per (document, writer) indefinitely.
- Refresh tokens and token expiry.
- Migration from v1.
- The client. It gets its own spec once the server is running.

## Build conventions

- **Location:** `packages/server-2`, a private workspace package. It's a forkable template, not a published library, and replaces `packages/server` once it works.
- **Stack:** TypeScript on Cloudflare Workers, Hono for routing, and Hono JSX for the server-rendered login, error and admin pages. Dependencies come from the pnpm workspace catalog (`pnpm-workspace.yaml`).
- **Schema:** D1 migrations in `migrations/`, applied with `wrangler d1 migrations apply`.
- **OAuth:** implement the sign-in flow by hand. Don't use `@cloudflare/workers-oauth-provider` (it's in the catalog): it keeps tokens in KV in its own format, which doesn't fit the `tokens` table, stable writer IDs or the admin device list.
- **Tests:** Vitest with `@cloudflare/vitest-pool-workers`, so tests run against real D1, R2 and Durable Objects. Keep v1's tripwire test asserting that every data SQL statement filters on `app_id`.
- **Carry over from v1** (`packages/server/src`): token generation and SHA-256 hashing, PBKDF2 password hashing and constant-time compare (`auth/auth.ts`, `apps.ts`), the `app_id` charset check, blob hash verification (`sync/blobs.ts`), and the hibernating `RealtimeDO` (`realtime/durableObject.ts`).
- **Code rules** (from [react-conventions.a16n.dev](https://react-conventions.a16n.dev); pact's version is `CLAUDE.md` on branch `claude/react-conventions-comments-0b1904`):
  - Comments only for unusual code, non-obvious invariants or security properties, external sources, or `TODO(<person>)`. Never narrate code or changes. No JSDoc tags or section banners.
  - Type-only imports use `type` specifiers.
  - No unused exports or dead code.
  - Numeric names carry their unit when it's ambiguous (`timeoutMs`, `sizeBytes`).
  - Env is read only through the typed `Env` bindings.
  - Committed scripts are TypeScript.
  - `pnpm check` (ESLint + Prettier), `pnpm tc` and `pnpm test` must pass. pnpm only.

## Infrastructure

| Binding / var                            | Purpose                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `DB` (D1)                                | all tables                                                               |
| `BLOBS` (R2)                             | blob bytes, keyed `<app_id>/<sha256>`                                    |
| `REALTIME` (Durable Object)              | one instance per app (`idFromName(app_id)`), holds that app's WebSockets |
| `LOGIN_LIMITER` (rate-limit binding)     | login attempts, keyed by IP and by username                              |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | Turnstile on the login page                                              |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`       | Cloudflare Access JWT verification for `/admin`                          |
| `MAX_PUSH_DOCUMENTS`                     | max documents per push (default 50)                                      |
| `AI` (Workers AI binding)                | `/ai` completions via AI Gateway                                         |

## Schema (D1)

```sql
users (id, username UNIQUE, password_hash, created_at)
apps (id PRIMARY KEY, name, seq, created_at)
app_redirect_uris (app_id, uri, PRIMARY KEY (app_id, uri))
auth_codes (code_hash PRIMARY KEY, app_id, user_id, device_id, device_name, redirect_uri, code_challenge, expires_at)
tokens (id PRIMARY KEY, token_hash UNIQUE, token_prefix, app_id, user_id NULL, device_id NULL, label, created_at, last_seen_at,
        UNIQUE (app_id, user_id, device_id))
documents (app_id, collection, id, writer_id, hlc, seq, data, PRIMARY KEY (app_id, collection, id, writer_id))
  UNIQUE (app_id, seq); INDEX (app_id, seq)
blobs (app_id, hash, mime_type, size, user_id NULL, device_id NULL, created_at, PRIMARY KEY (app_id, hash))
```

- `app_id` charset: `^[a-z0-9][a-z0-9_-]{0,63}$`.
- Passwords: PBKDF2 hashes. Tokens and auth codes: SHA-256 hashes; the raw values are never stored.
- `tokens.user_id` and `device_id` are null for admin-minted tokens; `label` holds the device name or the admin's label.
- `tokens.token_prefix` is the first 9 characters of the raw token (e.g. `pact_V1St`), stored so the admin panel can tell tokens apart.
- `apps.seq` is the app's last assigned `seq`. It starts at the app's creation time in milliseconds and only ever increases, including across a wipe. Because a new app starts above any `seq` a deleted app with the same ID could have reached, devices holding an old cursor still see every new write.
- Every data query filters on `app_id`.
- Revoking a token or deleting a user leaves their `documents` rows in place, since other writers still merge with them. Only deleting or wiping the app removes documents.
- `last_seen_at` is only written when the stored value is more than 5 minutes old, so most requests don't spend a D1 write on it.

## Admin panel (`/admin`)

Behind Cloudflare Access. The Worker verifies `Cf-Access-Jwt-Assertion` against the team's certs on every `/admin` request.

Every non-GET `/admin` request must carry an `Origin` header equal to the server's own origin, or it's rejected with 403. This blocks cross-site form posts riding on the Access cookie.

Server-rendered by the Worker (Hono JSX) with plain HTML forms; there's no separate frontend build or admin JSON API. Forms such as create, rename, mint and confirmations live in native `<dialog>` elements that post to the server: a failed submit re-renders the page with the dialog open and its error, and success redirects. Client-side script is limited to opening dialogs and copying a minted token.

Top level:

- **Apps:** list (name, ID, token count, document count, blob storage, created); create an app (name + ID).
- **Users:** list (username, active tokens, created); create (username + password), reset password, delete (revokes their tokens).

Inside an app:

- **Blobs:** paginated list (hash, type, size, uploaded) with download, plus blob count and total bytes.
- **Tokens:** two separate lists.
  - _API tokens_ (admin-minted, no user): label, token prefix, created, last used; mint (label, token shown once), revoke.
  - _Signed-in devices_ (from sign-in): user, device, signed in, last seen; sign out (revokes the token).
- **Settings:** rename; add and remove redirect URIs; wipe data (documents + blobs); delete app (removes data, blobs and tokens; confirmed by typing the app ID).

There is no document browser; the admin panel only shows document counts.

## Design

Mockups for the login, sign-in error and admin screens: https://claude.ai/artifact/1uz2jHb5jxeo3yYEM4P1P5 (Pact admin & login canvas). Match them for layout, components and copy.

- **Palette:** Hazel ([hazel.a16n.dev/tokens](https://hazel.a16n.dev/tokens)), dark variant. `packages/docs/.vitepress/theme/hazel.css` has the full light and dark palettes as `--hz-*` variables; reuse those names as CSS custom properties.
  - Surfaces: `deep1` header bar, inputs and table heads; `bg` page; `dim5` dialogs and selected nav; `dim4` borders; `dim3` input borders.
  - Text: `text` primary, `muted` secondary. Avoid `dim1`/`dim2` for text that must be read; they're below 4.5:1 on `bg`.
  - Accents: `green` primary actions and the active tab; `red` destructive actions and errors; `blue` links; `yellow` warnings; `purple` API tokens; `blue` user devices.
- **Type:** Fira Sans for UI, Fira Code for IDs, hashes, URIs and tokens.
- **Components:**
  - Buttons are 44px high with an 8px radius: primary is filled green, secondary is outlined, destructive is red (outlined, or filled for the final confirm).
  - Tables sit in a bordered, 12px-radius box that scrolls horizontally on narrow screens.
  - Dialogs have a title, a close button (closing returns no result), the fields, then Cancel and the main action right-aligned. Errors show under the field; the main button shows a spinner while pending.
  - Destructive confirms that remove an app require typing its ID.
- **No logo.** The wordmark is the word "pact" in Fira Sans.
- **Layout:** pages work at phone width. Nav and toolbars wrap, and touch targets are at least 44px.
- **Copy:** helpful, friendly and concise. Never narrate what the screen shows or does. Avoid "it's X, not Y" constructions and strings of very short sentences; prefer one sentence that tells the reader a consequence or next step.

## Discovery

`GET /.well-known/pact` (unauthenticated):

```json
{
  "version": 2,
  "authorize_url": "…/oauth/authorize",
  "token_url": "…/oauth/token",
  "max_push_documents": 50
}
```

It reveals nothing about which apps exist.

## Sign-in (OAuth 2.0 authorization code + PKCE)

1. The app opens `GET /oauth/authorize?app_id&redirect_uri&device_id&device_name&state&code_challenge&code_challenge_method=S256` in a browser auth session.
2. The server renders a username/password form with Turnstile, whatever the app ID.
3. On `POST`, the server checks the rate limit, Turnstile and credentials, **then** the app and redirect URI:
   - bad credentials → the form again, with a generic error;
   - unknown app or unregistered redirect URI → an error page, never a redirect;
   - success → redirect to `redirect_uri?code&state`.
4. The app calls `POST /oauth/token` with `{ grant_type: "authorization_code", code, code_verifier, redirect_uri, app_id }` and receives `{ access_token }`.
   - Codes expire after 60s, are single-use, and must match the app, redirect URI and PKCE challenge.
   - If the (app, user, device) already has a token row, the token is rotated on that row, so its `id` (the writer ID) stays stable.

**Redirect URIs** (per RFC 8252 / OAuth 2.1):

- Matching is an exact string comparison against the app's registered URIs.
- Loopback exception: a registered `http://localhost/…` or `http://127.0.0.1/…` URI matches any port, for local dev.
- Allowed forms: `https://…`, loopback `http://…`, and private-use custom schemes for native apps (e.g. `com.example.app:/callback` or an Expo scheme).

All other endpoints take `Authorization: Bearer <token>`. The token row supplies the app and the writer ID, and requests bump `last_seen_at`.

`GET /auth/check` → `{ app_id, user, device_name }`.

`POST /auth/signout` → 204. Deletes the caller's token row and closes its realtime sockets. The writer's documents stay.

## Documents

The server stores the latest version of each document per writer (`writer_id` = token row ID). `data` and `hlc` are opaque strings: the server never parses them. Clients merge siblings and run migrations.

**Push:** `POST /sync/push`

```json
{ "documents": [{ "collection": "…", "id": "…", "hlc": "…", "data": "…" }] }
```

- Upserts the writer's row for each document. Each row gets the next `seq` from the app's counter (`apps.seq`), incremented in the same batch. The batch is atomic.
- Response: `{ "seq": <highest assigned> }`.
- After it commits, the server broadcasts to the app's realtime DO.
- A push with more than `max_push_documents` documents is rejected with 413. The cap is configurable (`MAX_PUSH_DOCUMENTS`) so it can match the D1 per-invocation query limit of the deployment's plan.
- Clients split pending documents into chunks of at most `max_push_documents` and push them one after another. Each chunk is atomic; the push as a whole is not, and a failed chunk is retried.

**Pull:** `GET /sync/pull?cursor=<seq>[&collection=…]`

- Returns rows with `seq > cursor`, ordered by `seq`, 500 per page, optionally filtered to one or more collections.
- Response: `{ "documents": [{ collection, id, writer_id, hlc, seq, data }], "cursor": <seq>, "hasMore": bool }`.

**Pull one:** `GET /sync/pull?collection=…&id=…` returns all sibling rows for that document.

## Limits

| Item                         | Limit                                                 |
| ---------------------------- | ----------------------------------------------------- |
| `data`                       | 1 MB (D1 caps a row at 2 MB)                          |
| documents per push           | `MAX_PUSH_DOCUMENTS`, default 50                      |
| blob                         | 50 MB (the body is buffered in Worker memory, 128 MB) |
| `collection`, document `id`  | 1–256 chars                                           |
| `hlc`                        | 1–64 chars                                            |
| `device_id`                  | 1–128 chars, `[A-Za-z0-9_-]`                          |
| `device_name`, token `label` | 1–100 chars                                           |
| username                     | 1–64 chars                                            |
| password                     | 8–256 chars                                           |

## Blobs

- `PUT /sync/blobs/:hash`: the body is buffered and its SHA-256 verified against `:hash` (400 `hash_mismatch` if it doesn't match). The bytes go to R2 with the request's content type, and a `blobs` row is upserted. Idempotent.
- `GET /sync/blobs/:hash`: the bytes, or 404.
- `GET /sync/blobs`: `{ "hashes": [...] }` for the app.

## CORS

Applies to `/oauth/token`, `/auth/*`, `/sync/*` and `/ai/*`.

- Allowed origins for an app: `http://localhost:*` and `http://127.0.0.1:*`, plus the origins of the app's registered `https` redirect URIs.
- Preflights carry no token, so `OPTIONS` answers for any origin. The check happens on the actual request: the origin is matched against the token's app (or `app_id` for `/oauth/token`). A request from a disallowed origin gets 403 `origin_not_allowed` with no `Access-Control-Allow-Origin` header.
- `/sync/*` allows the `authorization` and `content-type` headers. `/ai/*` allows any headers.
- Requests without an `Origin` header (native apps, scripts) aren't affected.
- `/realtime` applies the same origin rule to the WebSocket upgrade's `Origin` header.

## Realtime

- `GET /realtime?token=<token>`: a WebSocket upgrade, forwarded to the app's DO. The socket is tagged with the token ID.
- Server → client: `{ "type": "changed", "seq": <latest> }` after each push.
- Revoking a token in the admin panel, or signing out, closes its open sockets.

## AI completions

`POST /ai/chat/completions`: OpenAI chat-completions request and response shape, so AI SDK clients can use `<server>/ai` as their base URL.

- Any valid token can call it, including admin-minted ones.
- The server calls `env.AI.run(body.model, body, { gateway: { id: "default" } })`. Models are `provider/model` (e.g. `openai/gpt-4.1-mini`) and are billed via Unified Billing, with no provider keys. Responses, including streams, are returned in the OpenAI shape.
- Gateway metadata tags each request with `{ app: <app_id>, token: <token id> }` for logs and spend limits.
- Clients choose the model, prompts and tools.
- Its CORS allows any headers, since AI SDK clients send more than `authorization`/`content-type`.

## Errors

JSON endpoints return `{ "error": "<message>", "code": "<code>" }`.

| Status | `code`               | When                                                    |
| ------ | -------------------- | ------------------------------------------------------- |
| 400    | `bad_request`        | malformed body or params, or a field outside its limits |
| 400    | `hash_mismatch`      | the blob body doesn't hash to `:hash`                   |
| 401    | `unauthorized`       | missing, unknown or revoked token                       |
| 403    | `origin_not_allowed` | the request's `Origin` isn't allowed for the app        |
| 404    | `not_found`          | unknown blob or route                                   |
| 413    | `too_many_documents` | push exceeds `max_push_documents`                       |
| 413    | `document_too_large` | a document's `data` exceeds 1 MB                        |
| 413    | `blob_too_large`     | blob exceeds 50 MB                                      |
| 502    | `ai_upstream_error`  | AI Gateway returned an error or failed                  |

`/oauth/token` uses the standard OAuth error format instead: `{ "error": "invalid_request" | "invalid_grant" | "unsupported_grant_type" }`, with status 400. The login and authorize pages render errors as HTML.

## Deploy

`pnpm setup --domain sync.example.com` (in `packages/server-2`) runs the steps below. It creates the D1 database and R2 bucket, fills in `wrangler.jsonc`, applies migrations, deploys, and stores the Turnstile secret. Access is set up in the dashboard: the script points you there and asks for the team domain and AUD tag. With `CLOUDFLARE_API_TOKEN` set (Account Settings: Read, Turnstile: Edit) it creates the Turnstile widget too; otherwise it asks for its keys. Re-running skips what already exists.

The manual steps, for reference:

1. **Fork the template** and install dependencies.
2. **Create the D1 database and R2 bucket:** `wrangler d1 create pact` and `wrangler r2 bucket create pact-blobs`, then put the database ID in `wrangler.jsonc`.
3. **Bindings in `wrangler.jsonc`:**
   - `d1_databases`: `DB`
   - `r2_buckets`: `BLOBS`
   - `durable_objects`: `REALTIME` → `RealtimeDO`, with a `new_sqlite_classes` migration
   - `ratelimits`: `LOGIN_LIMITER`, `simple: { limit: 10, period: 60 }`
   - `ai`: `{ "binding": "AI" }`
   - `vars`: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `TURNSTILE_SITE_KEY`, and optionally `MAX_PUSH_DOCUMENTS`
4. **Apply migrations:** `wrangler d1 migrations apply DB --remote`.
5. **Deploy:** `wrangler deploy`, then attach a custom domain (e.g. `sync.example.com`).
6. **Cloudflare Access:** in Zero Trust → Access → Applications, add a self-hosted application for `<domain>/admin` with a policy for the admin's email. Copy its Application Audience (AUD) tag into `ACCESS_AUD`, and `<team>.cloudflareaccess.com` into `ACCESS_TEAM_DOMAIN`.
7. **Turnstile:** add a widget for the domain. Put the site key in `TURNSTILE_SITE_KEY`, and set the secret with `wrangler secret put TURNSTILE_SECRET`.
8. **AI (optional):** enable AI Gateway billing (Unified Billing) on the account. The `default` gateway is created on first use.
9. **Redeploy** after setting vars, open `/admin`, and create the first app and user.
