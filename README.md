## Pact

Pact is an intentionally simple client/server architecture for building local-first apps designed to be used by a small group of individuals and agents collaborating in real-time in a high trust environment.

| Package                                | What it is                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/client`](./packages/client) | `@a16n/pact-client`, published to npm. A local-first document store with sync, realtime, collaborative text, blobs, migrations, end-to-end encryption and background tasks.                    |
| [`packages/server`](./packages/server) | The sync server, a Cloudflare Worker backed by D1, R2 and a Durable Object. It's a reference deployment to fork and deploy, not a package. Its API is in [`api.md`](./packages/server/api.md). |

To deploy your own server, run `pnpm run setup --domain sync.example.com` from `packages/server`, then `pnpm run migrate` and `pnpm run deploy`.

## Development

```sh
pnpm install
pnpm tc     # typecheck
pnpm check  # ESLint + Prettier
pnpm test
```
