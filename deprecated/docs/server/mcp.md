# Agents & MCP

Pact treats **agents as first-class users** — but not as part of the server. The sync server is generic and [multi-tenant](/server/auth); MCP tools are domain code that belongs to one app. So an agent's MCP server is a **separate, per-app Worker built on `@a16n/pact-client`** that connects to the sync server as an ordinary client.

```
  human clients ──────────────┐
                              ▼
                      @a16n/pact-server          (generic, multi-tenant,
                              ▲                   no app domain code)
  agent ──▶ your MCP Worker ──┘
            (@a16n/pact-client + your app's
             tools & repositories)
```

## Why not bundle the MCP into the server?

An earlier iteration of Pact shipped in-Worker agent building blocks (`D1Adapter`, `createOAuthAuthApp`). With multi-tenancy they were removed, deliberately:

- **The server stays app-agnostic.** MCP tools are domain logic (`createRecipe`, `listPantry`, …). Bundling them means the shared server's deploy depends on every app's domain package, and one app's bad code can take down every tenant's sync.
- **Tenant isolation applies to the agent itself.** Code inside the sync Worker holds `env.DB` and could physically read any app's rows. A standalone MCP Worker holds only **one app's token** — cross-tenant access is impossible rather than merely disallowed.
- **Independent deploys.** Each app's agent surface ships from its own repo on its own schedule.

## What an MCP Worker looks like

From the data's perspective an agent is just another client (see [Authentication](/server/auth)):

1. **Register** — trade the app's password for a token via `POST /auth/register` (or `Store.registerClient`). Registering one client per connecting agent (rather than one shared credential for the whole Worker) gives each agent its own token, identity, and `last_seen_at` — do this in your OAuth authorize flow, storing the returned `pact_` token in the grant's props.
2. **Read & write** through `@a16n/pact-client` — the same `Store` + repositories your app uses, so tool code and client code share one API. Writes go through `/sync/push`, so realtime invalidations fan out to the app's other clients for free.
3. **Author identity** — give the agent its own author id (e.g. `us-mcp-…`) so its writes are attributable like any other user's.

The MCP protocol layer itself (tool definitions, OAuth via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider), transport) is standard Workers + MCP SDK territory — Pact adds nothing agent-specific, which is the point.

## Advertising the capability

If you want clients to know an agent surface exists, merge a flag into the sync server's `GET /info`:

```ts
export default createSyncApp({ info: { mcp: true } });
```

```json
// GET /info
{ "name": "Our Household", "protocolVersion": 3, "realtime": true, "mcp": true }
```

Reserved keys (`name`, `protocolVersion`, `realtime`) can't be overridden; everything else in `info` is yours to advertise.
