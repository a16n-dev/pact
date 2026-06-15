# Fond - Recipe & Cooking Data Layer

pnpm monorepo split into two top-level scopes/directories: `pact/` holds `@pact/*` — a generic, domain-agnostic sync framework — and `fond/` holds `@fond/*` — the Fond recipe/cooking app built on top of it.

## Packages

`@pact/*` — generic sync framework (no Fond knowledge):

| Package | Purpose |
|---------|---------|
| `@pact/client` | Document store: `Store`/`Collection`, adapters (in-memory, etc.), `Migrator`, sync client, realtime, `BaseDocument` |
| `@pact/server` | Hono sync server for Cloudflare Workers (D1 + R2): sync/blob/auth/realtime, OAuth + landing scaffolding, and the in-Worker `D1Adapter` |

`@fond/*` — the Fond app:

| Package | Purpose |
|---------|---------|
| `@fond/core` | Fond data layer in three eslint-enforced internal layers: `model` (Zod schemas + migrations + constants), `domain` (pure logic: ingredient parsing, recipe diffing, seasonality, unit conversion), `data` (repositories + seeds + sync glue) |
| `@fond/react` | React hooks (TanStack Query) for data access and sync |
| `@fond/app` | Expo/React Native mobile app (Expo Router, Expo SQLite, Tailwind/Uniwind) |
| `@fond/explorer` | Read-only web DB explorer (React Router, Vite, Tailwind) |
| `@fond/cli` | CLI tool (Commander.js, better-sqlite3) |
| `@fond/server` | Deployable Cloudflare Worker (`fond-server`): extends `@pact/server` with MCP tools |

Dependency chain: `@pact/client` <- `@fond/core` <- `@fond/react` <- `@fond/app`/`@fond/explorer`; `@fond/cli` and `@fond/server` build on `@fond/core` (`@fond/server` also on `@pact/server`). Inside `@fond/core`: `model` <- `domain` <- `data` (enforced via eslint-plugin-boundaries).

## Commands

Always use pnpm scripts, never run tools directly.

```sh
# Run across all packages (from repo root)
pnpm tc        # typecheck
pnpm check     # lint + format check
pnpm format    # auto-fix lint + formatting
pnpm test      # tests (@fond/core, @pact/client, @pact/server have tests)

# Or scope to a specific package
pnpm -F @fond/core tc
pnpm -F @fond/core check
pnpm -F @fond/core format
pnpm -F @fond/core test
pnpm -F @fond/core test:watch

# Start Expo dev server
pnpm -F @fond/app start
```

## Development

- All packages — including the CLI, typecheck, tests, and app/web dev — resolve workspace dependencies from **source TypeScript**: each package.json `exports` field points directly at `./src/index.ts`. You do not need to run `pnpm build:packages` for any normal development task.

## Code Style

- Prettier: semicolons, single quotes (incl. JSX), trailing commas (es5), 100 char width
- JSX strings live in curly braces: `prop={'value'}` and `<Text>{'hello'}</Text>` (enforced via `react/jsx-curly-brace-presence`)
- ESLint: TypeScript ESLint recommended rules, React/React Hooks plugins for app code
- Unused variables/args must be prefixed with `_`
- Each package has its own tsconfig.json with strict mode enabled

## Data access in the app: read-model hooks

Components read data through join-shaped read-model hooks, not by assembling joins inline.

- `@fond/react` exposes one suspense list hook per collection (`useRecipes`, `useIngredients`, …) plus read-model hooks that join collections (`useShoppingList`, `usePantryAisleGroups`, `useResolvedRecipeIngredients`, `useResolvedCookLogs`, `useRecipeSeasonality`, …). Id-keyed map hooks exist only inside the package (`hooks/maps.ts`) and are deliberately not exported — don't re-add them to the public surface.
- A component body never combines two collections. If a screen needs records joined across collections, that join is a read-model hook.
- Placement: pure derivation over document types goes in `@fond/core` `domain/` (a function taking lists/maps); the hook wrapping it for cross-feature use lives in `@fond/react`; feature-specific/UI shaping (filters, view models, day bucketing) stays at the feature root in the app, operating on read-model hook output.
- Read-model hooks are join-shaped, not screen-shaped: they take data arguments only (a recipe, an id), never behavior flags. A screen needing extra data calls another hook; it doesn't add a flag or an optional field to an existing one.
- Single-FK lookups (one record by id) use the single-entity hooks (`useRecipe(id)`) or `list.find()` on tiny collections — no map needed.

## Naming: grocery vs shopping

These are not synonyms — pick by what the name refers to.

- **grocery** — data nouns / catalog concepts: `GroceryItem`, `GroceryAisle`, `GroceryStore`, `useGroceryItems`, `collapseGroceryItems`, doc-id prefixes (`g/`, `ga/`, `gs/`).
- **shopping** — the user activity / list UI: `feature/shopping/`, `ShoppingScreen`, `ShoppingListRow`, the `(tabs)/shopping` route, "add to shopping list".

Mnemonic: you can't have a "shopping aisle" or "shopping store" — those are physical-world things, so they're grocery. You don't have a "grocery screen" — that's a UI surface for an activity, so it's shopping.

## App Tech Stack

- **Navigation**: Expo Router (file-based routing in `src/app/`)
- **Styling**: Tailwind CSS v4 + Uniwind, class-variance-authority for component variants
- **Icons**: lucide-react-native
- **Path aliases**: `@/*` -> `src/*`, `@/assets/*` -> `assets/*`
