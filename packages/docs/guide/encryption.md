# Encryption (E2E)

Pact can optionally encrypt documents **end-to-end**: domain fields are sealed into a single ciphertext string, and that same sealed form is what's persisted locally *and* what the server stores. Plaintext exists only in memory — docs are decrypted as they're read, on the device holding the key.

It's purely opt-in. A Store without the option behaves exactly as before, and the server needs no configuration at all — it [already treats `data` as opaque](/reference/schema).

## What the server (and local storage) sees

```jsonc
{
  "id": "rcp-abc123",
  "schemaVersion": 3,
  "createdAt": "2026-07-01T10:00:00.000Z",
  "updatedAt": "2026-07-22T08:12:00.000Z",
  "createdBy": "us-alice",
  "updatedBy": "us-alice",
  "deletedAt": null,
  "deletedBy": null,
  "enc": "pactenc$1$<iv>$<ciphertext>"
}
```

The `BaseDocument` fields stay cleartext — last-write-wins merging, author reassignment, and audit all need them. Everything else (your domain fields) is AES-256-GCM ciphertext. The document's identity (`collection/id`) is bound into the encryption as authenticated data, so an envelope can't be transplanted onto a different document without failing to decrypt.

## Enabling it

```ts
import { Store, createWebCryptoCipher, deriveEncryptionKey } from '@a16n/pact-client';

// Derive a key from a passphrase the group shares (salt = your appName so
// every member derives the same key), or load 32 raw bytes from a keychain.
const key = await deriveEncryptionKey(passphrase, 'myapp');

const store = await Store.create(adapter, blobAdapter, {
  ...domain,
  encryption: { cipher: createWebCryptoCipher(key) },
});
```

`createWebCryptoCipher` uses WebCrypto (Workers, Node, web). React Native apps supply their own `DocCipher` implementation (the interface is two methods, `seal`/`open`) backed by a native crypto module.

`Store.create` verifies the key against a sealed sentinel in `_config/encryption` and **fails fast with a clear error if the key doesn't match the store's existing data** — no scattered decrypt failures mid-read.

## Enabling on an existing install

Reads pass plaintext rows through untouched, so a store with pre-encryption history works immediately. To convert it fully:

```ts
await store.encryptLocalData(); // rewrite local rows as ciphertext
await store.pushAll(); // overwrite the server's plaintext copies
```

`pushAll` works because the server's last-write-wins guard accepts equal `updatedAt` — each plaintext row on the server is replaced by its encrypted twin.

## Threat model — what this does and doesn't hide

**Hidden:** every domain field's content — from the sync server's operator, from Cloudflare storage at rest (D1 rows, backups), and from anything reading the device database file.

**Still visible (by design, sync needs them):** collection names, document ids (an id prefix like `rcp-` reveals the type), timestamps, author ids, document count and sizes, write timing.

**Not covered:** blob bytes (images upload as-is; encrypting them while keeping content-addressed sync is a possible later addition), local backups from `createBackup` (they export plaintext — treat archive files like the data itself), and internal `_*` collections (never synced; the persisted sync token relies on device-level protection).

## Keys are yours to manage

- **Everyone needs the key**: every client of the app — every device, and an agent's [MCP Worker](/server/mcp) if you run one — must be configured with the same key. A client without it sees envelopes it can't open.
- **Losing the key loses the data** on the server: there is no recovery path. Local plaintext never exists at rest, so back the passphrase up like it matters.
- **Rotation** is manual: construct a Store with the new cipher, `encryptLocalData()` + `pushAll()` from one up-to-date device, reconfigure the other clients. (They'll need to re-pull; the `_config/encryption` check doc must be cleared on devices switching keys.)
