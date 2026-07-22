# Examples

Working, tested reference material for building on Pact. Nothing here is published — it exists to be read and copied.

| Example                  | What it shows                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`todo-cli`](./todo-cli) | A complete client app (Node CLI): domain definition with `defineCollection`, a copied storage adapter, typed CRUD, and the optional register → author → sync flow.          |
| [`adapters`](./adapters) | Copy-paste `DatabaseAdapter` implementations — localStorage, IndexedDB, JSON file, `node:sqlite`, `expo-sqlite` — plus a reusable contract test suite for writing your own. |
