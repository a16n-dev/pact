# Pact 2 server API

The HTTP and WebSocket surface a client builds against. Everything a client needs is here; the server's internals are not part of the contract.

## Concepts

- **App.** A registered application identified by an `app_id`. All of an app's data is shared by everyone signed in to it. Apps are created in the admin panel, not through this API.
- **Token.** An opaque bearer string (`pact_…`) scoped to one app. A _device token_ comes from sign-in and belongs to a user and a device. An _API token_ is minted by an admin and belongs to nobody. Tokens don't expire; they stop working when revoked or signed out.
- **Writer.** Every token has a stable `writer_id`. Signing in again on the same device rotates the token but keeps the writer ID.
- **Document.** Identified by `(collection, id)`. The server doesn't store a document as a whole. It stores one **version** per writer: that writer's latest state of the document. A client reads all the versions of a document and merges them itself.
- **`seq`.** A per-app counter. Every version written gets the next value, so a client can ask for "everything after the last `seq` I saw".
- **`hlc` and `data`.** Opaque strings. The server never parses them. `hlc` is for the client's own ordering (a hybrid logical clock by convention); `data` is the document body in whatever encoding the client chooses.
- **Blob.** Immutable bytes addressed by their SHA-256 hash, per app.

## Conventions

- Base URL: the server's origin, e.g. `https://sync.example.com`.
- Authenticated requests send `Authorization: Bearer <token>`. The token determines the app.
- Request and response bodies are JSON unless stated. Timestamps are Unix milliseconds.
- Errors are JSON with the shape in [Errors](#errors). The sign-in pages return HTML, and `/oauth/token` uses the OAuth error shape.

## Discovery

`GET /.well-known/pact`. No auth.

```json
{
  "version": 2,
  "authorize_url": "https://sync.example.com/oauth/authorize",
  "token_url": "https://sync.example.com/oauth/token",
  "max_push_documents": 50
}
```

Use `max_push_documents` to size push batches. The response says nothing about which apps exist.

## Sign-in

OAuth 2.0 authorization code with PKCE (S256 only). The client opens a browser to the authorize URL, the user signs in with a username and password, and the browser is redirected back to the client with a code to exchange for a token.

### 1. Open the authorize URL

`GET /oauth/authorize` with these query parameters, all required:

| Parameter               | Value                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `app_id`                | the app, `^[a-z0-9][a-z0-9_-]{0,63}$`                                                                |
| `redirect_uri`          | where to send the user back; must match one registered for the app (see below)                       |
| `device_id`             | a stable ID for this installation, 1–128 chars of `[A-Za-z0-9_-]`; the same ID keeps the same writer |
| `device_name`           | shown to the user and the admin, 1–100 chars                                                         |
| `state`                 | opaque, 1–512 chars; echoed back on the redirect, check it matches                                   |
| `code_challenge`        | base64url(SHA-256(`code_verifier`)), 43–128 chars of `[A-Za-z0-9_-]`                                 |
| `code_challenge_method` | `S256`                                                                                               |

The server renders its own login page. If any parameter is missing or malformed it renders an error page (400) and never redirects.

After a successful sign-in the browser is remembered for 30 days with a cookie scoped to this page, so the next app to open it is offered **Continue as &lt;username&gt;** without a password. The user can pick **Use a different account** to forget the browser; resetting or deleting the user does the same.

**Redirect URIs** are registered per app by the admin and matched by exact string comparison. Allowed forms are `https://…` and private-use schemes for native apps such as `com.example.app:/callback`. When the admin turns on the app's **Allow localhost** switch, any `http://localhost/…` or `http://127.0.0.1/…` URI on any port is accepted too, so local dev servers can use whatever port is free.

### 2. Receive the redirect

On success the browser lands on `redirect_uri?code=…&state=…`. The code is single-use and expires 60 seconds after it was issued.

If the credentials are wrong, or the app restricts access and the user isn't on its list, the user sees the form again with the same generic error. If the app or redirect URI is unknown the user sees an error page; the client is never redirected, so it should time out or let the user cancel.

### 3. Exchange the code

`POST /oauth/token`. No auth. JSON or form-encoded body:

```json
{
  "grant_type": "authorization_code",
  "code": "…",
  "code_verifier": "…",
  "redirect_uri": "…",
  "app_id": "…"
}
```

`redirect_uri` and `app_id` must equal the values used in step 1.

Response: `{ "access_token": "pact_…", "token_type": "bearer" }`. Store the token; it's shown nowhere else.

Errors are status 400 with `{ "error": "invalid_request" | "invalid_grant" | "unsupported_grant_type" }`. `invalid_grant` covers an expired, used or unknown code, a wrong verifier, and a mismatched app or redirect URI.

## Session

Both require auth.

**`GET /auth/check`** → `{ "app_id": "…", "user": "<username> | null", "device_name": "…" }`. `user` is null for API tokens. Use it to validate a stored token on startup.

**`POST /auth/signout`** → 204. Deletes the token and closes its realtime sockets. The writer's versions stay on the server, so other clients keep merging with them.

## Documents

Requires auth.

### Push

`POST /sync/push`

```json
{
  "documents": [{ "collection": "notes", "id": "n1", "hlc": "…", "data": "…" }]
}
```

| Field        | Limit                        |
| ------------ | ---------------------------- |
| `collection` | 1–256 chars                  |
| `id`         | 1–256 chars                  |
| `hlc`        | 1–64 chars                   |
| `data`       | 1 byte to 1 MB (UTF-8 bytes) |
| array length | at most `max_push_documents` |

Each entry replaces the caller's version of that document. Each version gets the next `seq`. The whole request is one atomic write: either every entry lands or none does.

Response: `{ "seq": <highest seq assigned> }`. An empty `documents` array is allowed and returns the app's current `seq` without writing.

After the write commits, every realtime socket on the app receives a `changed` message.

To push more than `max_push_documents` documents, split them into chunks and push the chunks one after another. Each chunk is atomic; the sequence as a whole is not, so a failed chunk is retried on its own. Re-pushing a version the server already has is harmless: it gets a new `seq` and the same content.

### Pull changes

`GET /sync/pull?cursor=<seq>[&collection=<name>]…`

- `cursor` is required and is a non-negative integer. Pass `0` for a full download, otherwise the `cursor` from the previous response.
- `collection` may repeat to restrict the result to those collections. With none, all collections are returned.

```json
{
  "documents": [
    {
      "collection": "notes",
      "id": "n1",
      "writer_id": "…",
      "hlc": "…",
      "seq": 1760590000123,
      "data": "…"
    }
  ],
  "cursor": 1760590000123,
  "hasMore": false
}
```

Entries are versions with `seq > cursor`, in `seq` order, 500 per page. `cursor` is the last `seq` in the page (or the request's cursor when the page is empty); pass it back while `hasMore` is true. A client's own versions come back too, with its `writer_id`.

The sync loop is: pull until `hasMore` is false, merge each document's versions by `(collection, id)`, persist the final `cursor`, and repeat on every `changed` message or reconnect.

### Pull one document

`GET /sync/pull?collection=<name>&id=<id>`

Returns every version of that document across all writers, oldest `seq` first, in the same shape as above with `hasMore: false`. Exactly one `collection` is required with `id`. Unknown documents return an empty `documents` array, not 404.

## Blobs

Requires auth. `:hash` is the lowercase hex SHA-256 of the bytes.

**`PUT /sync/blobs/:hash`** with the raw bytes as the body and a `Content-Type` header. The server hashes the body and rejects it if it doesn't match (`400 hash_mismatch`). Returns 204. Uploading the same hash again is a no-op that keeps the first upload's content type. Bodies over 50 MB are rejected by declared length before they're read, and by actual length after.

**`GET /sync/blobs/:hash`** returns the bytes with the stored `Content-Type` and `Content-Length`, or `404 not_found`.

**`GET /sync/blobs`** → `{ "hashes": ["…"] }`, every blob hash the app has. Use it to find what still needs uploading or downloading.

Blobs are never deleted through this API.

## Realtime

`GET /realtime?token=<token>` as a WebSocket upgrade. Browsers can't set headers on an upgrade, so the token is a query parameter. A plain request without the upgrade header gets 426.

The server pushes one message type:

```json
{ "type": "changed", "seq": 1760590000123 }
```

sent to every socket on the app after each push, including the pushing client's own. Treat it as a hint to pull; `seq` is the new highest value, so a client can skip the pull if its cursor already equals it. The client never needs to send anything; messages from the client are ignored.

The socket closes with code 1000 and reason `signed out` when the token is signed out or revoked. On any other close the client should reconnect with backoff and pull once connected, since messages sent while it was away are not replayed.

## CORS

Browser clients work from `http://localhost:*` and `http://127.0.0.1:*` without configuration, plus the **App domains** the admin registers for the app. Adding an `https` redirect URI registers its domain too. A request from any other origin gets `403 origin_not_allowed`. Requests without an `Origin` header, such as native apps and scripts, aren't checked. Discovery names no app, so it's served to any origin.

Preflights succeed for any origin. On `/oauth/token`, `/auth/*` and `/sync/*` the allowed request headers are `authorization` and `content-type`; on `/ai/*` any requested header is allowed. The realtime upgrade applies the same origin rule.

## AI

`/ai/*`. Requires auth; any token works, including API tokens. An admin can turn the AI proxy off for an app in its settings, after which every request here is `403 ai_disabled`.

Everything under `/ai` is forwarded to the server's [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/), so `<origin>/ai/<provider>` is a drop-in base URL for that provider's own SDK with the Pact token as the API key. The gateway supplies the provider credentials, so send none of your own. The method, path, query string, body and response all pass through unchanged, streaming included. Some examples:

| Provider SDK                    | Base URL                                              |
| ------------------------------- | ----------------------------------------------------- |
| Anthropic                       | `<origin>/ai/anthropic`                               |
| OpenAI                          | `<origin>/ai/openai`                                  |
| Google AI Studio                | `<origin>/ai/google-ai-studio`                        |
| OpenAI-compatible, any provider | `<origin>/ai/compat` with `model` as `provider/model` |

The server strips `Authorization`, `x-api-key` and any `cf-*` header before forwarding, so a request can't bring its own provider key or change gateway settings. Which gateway is used is fixed by the server's configuration, and every request is logged there with the app and token that made it.

An upstream failure or 5xx is `502 ai_upstream_error`. Upstream 4xx responses pass through as-is. A server with no gateway configured answers `503 ai_not_configured`.

## Errors

JSON endpoints return `{ "error": "<human-readable message>", "code": "<code>" }`.

| Status | `code`               | When                                                    |
| ------ | -------------------- | ------------------------------------------------------- |
| 400    | `bad_request`        | malformed body or params, or a field outside its limits |
| 400    | `hash_mismatch`      | the blob body doesn't hash to `:hash`                   |
| 401    | `unauthorized`       | missing, unknown, signed-out or revoked token           |
| 403    | `origin_not_allowed` | the request's `Origin` isn't allowed for the app        |
| 404    | `not_found`          | unknown blob or route                                   |
| 413    | `too_many_documents` | push exceeds `max_push_documents`                       |
| 413    | `document_too_large` | a document's `data` exceeds 1 MB                        |
| 413    | `blob_too_large`     | blob exceeds 50 MB                                      |
| 426    | `bad_request`        | `/realtime` called without a WebSocket upgrade          |
| 500    | `internal_error`     | unexpected server failure                               |
| 502    | `ai_upstream_error`  | AI Gateway returned an error or failed                  |
| 403    | `ai_disabled`        | the admin turned the AI proxy off for the app           |
| 503    | `ai_not_configured`  | the server has no AI Gateway configured                 |

A 401 means the token is gone for good: clear it and send the user through sign-in again.

## Limits

| Item                        | Limit                             |
| --------------------------- | --------------------------------- |
| `data` per document         | 1 MB                              |
| documents per push          | `max_push_documents`, default 50  |
| versions per pull page      | 500                               |
| blob                        | 50 MB                             |
| `collection`, document `id` | 1–256 chars                       |
| `hlc`                       | 1–64 chars                        |
| `device_id`                 | 1–128 chars, `[A-Za-z0-9_-]`      |
| `device_name`               | 1–100 chars                       |
| `state`                     | 1–512 chars                       |
| authorization code lifetime | 60 seconds, single use            |
| sign-in attempts            | 10 per minute per IP and per user |

## What the server does not do

So the client knows what's on its side of the line:

- Merge versions, resolve conflicts, or interpret `hlc` and `data`.
- Prune old versions. One version per writer is kept indefinitely, so a document pulled by `(collection, id)` always returns every writer that ever touched it.
- Delete blobs, or know which documents reference them.
- Expire tokens or refresh them.
- Enforce per-user access within an app.
- Replay realtime messages missed while disconnected.
