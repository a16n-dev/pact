# Pact conventions

Adapted from https://react-conventions.a16n.dev (the non-React, non-project-structure rules).

## Comments

Use comments sparingly. Prefer self-documenting code. Never use a comment to narrate what the code does or to describe a change that was made.

A comment is justified only when it is one of:

- **Unusual code** — the code is written in an unexpected way, and the comment says why the conventional approach was not used.
- **Non-obvious behaviour** — a side effect, invariant, ordering constraint, or security property a future maintainer must know and cannot read from the code.
- **External source** — the code is taken or adapted from elsewhere; cite it.
- **API boundary** — a `/** */` doc comment on a symbol exported from the public client API (`packages/client/src/index.ts`) when it adds information beyond the name and type signature. Do not restate the signature or describe the implementation.
- **Temporary stub** — a `TODO(<person>)` (never an agent) saying what remains.

Formatting:

- `//` for code comments, `/** */` for doc comments only.
- No JSDoc tags (`@param`, `@returns`, `@throws`); the types already say it.
- Place each comment directly above the code it refers to. No section-divider banners.
- Tests: the test name carries the intent. Comment only the non-obvious setup or assertion.

Process: when an agent writes code, add and review comments in a separate pass after the code change is finished, so comments that narrate the change get dropped.

## Code

- **Type-only imports** — use inline `type` specifiers, or top-level `import type` when every name is a type. Enforced by ESLint.
- **No unused exports** — export a symbol only when another module imports it. Promote to export when needed; drop the export when nothing uses it. Documented operator-only functions (the `wipeAll*ViaApi` family) are the exception.
- **No unused code** — when a change leaves code unused, delete it, along with nearby dead code when safe.
- **Name units for numbers** — suffix numeric names whose unit is ambiguous (`timeoutMs`, `sizeBytes`). Counts and versions need no suffix.
- **Typed env config** — read environment in one place and validate it. The server gets its config as typed Cloudflare bindings (`Env`); nothing else reads `process.env`.
- **Scripts in TypeScript** — any committed script is `.ts`, not `.js`. Tool config files (`eslint.config.js`) are exempt.
- **Lint is blocking** — `pnpm check` (ESLint + Prettier) and `pnpm tc` must pass; rules are errors, not warnings.
- **pnpm only** — never `npm` or `yarn`.
