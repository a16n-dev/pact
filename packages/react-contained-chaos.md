# Contained Chaos - building & scaling vibe-coded React apps

Reacts greatest strength is the freedom it gives you in how you want to structure and build out your app. This is also it's greatest weakness; Without strict guardrails and conventions, a React codebase can quickly become a tangled mess of dependencies and components. Even teams with combined decades of experience often struggle with this. The problem only gets worse when vibe coding, and "does it work?" becomes the primary evaluation criteria. 

## Foundations

* Invest the time in building strong foundations for feature code to layer on top of. 
  * **Application code** - Routing, data fetching, design systems, error handling
  * **Code style** & verification - Linters, formatters, typechecks, preview environments
  * **CI/CD** - automated deployments, observability & monitoring, easy rollbacks

## Screens as organisation

* An app is made up of many screens. Screens are the only components that should concern themselves with url/query params.
* Screens should never be used as children of other components or screens. They should be plugged directly into the routing system.
* Screens should primarily be responsible for composing UI, ideally never reaching for low level or design-system level components.
* Files containing screen components should never contain any other components or functions.
* Screens should fetch only the primary data for the screen (ie the "entity"). This fetching should happen under suspense, such that top-level loading & error states are not the concern of the screen itself.
* Any other data required by specific elements on the screen should be fetched by those elements, and those elements should be responsible for their own loading & error states.

## Modular features

* All features in the app live under `src/features/[feature-name]`. In many cases there is a 1:1 mapping between a feature and a screen, but some features may have multiple screens. Screens by definition cannot be shared between features.
* Code within a feature directory cannot be accessed by any sibling feature directories, or by any parent directories. AThe screens are be considered the "public API" of a feature, and the rest of the feature code is considered private.
* There may be many agents working on the codebase simultaneously. Clear boundaries and guardrails are essential to prevent conflicts and context bloat.

## Shared code

* Code is cheap, testing is expensive. Contained, easy to reason about changes beat DRY in almost all scenarios by minimising the chance of unintended regressions. Code changes within a feature should be fully verifiable by testing only that feature. 
* Deduplication happens at the data layer and design system component layer, not at the feature layer.
* If two features require some similar looking UI, prefer to duplicate the code rather than creating a shared component. If this is complex, it's usually a sign that the base component system or data layer is not as developed as it should be.

## Code quality and correctness

* Lean heavily on cheap verification gates - typechecks, linting, formatting. Invest the upfront time in making sure these are configured as tightly as possible.
* Constraints that would feel too rigid or overly prescriptive for a human development team are ideal in an agent-managed codebase. Think strict file-length limits, hard import boundaries - things that are easy to measure, and enforce.
* Unit tests are purely a tool for asserting that "This code does what I (the agent) think it does", which is inherently less valuable than asserting "This code does what I (the human) think it does". 
* Lean on foundational code and battle-tested libraries where possible, every new line of code is a potential source of bugs and regressions.

## Client/server split

* Decide early if the majority of the business logic will live on the client or the server. Either has it's pros & cons, but mixing the two leads to increased complexity, with code that is both harder to test and harder to reason about.

## Managed complexity

* Work under the assumption that, at various points, a human will still need to work in the codebase. Consistency, clear structure and concise documentation make this possible.

---

The intra-feature dependency problem:

* Ideally each feature can define some public surface area. This also then provides a layer of abstraction over routing (ie `openRecipe()` instead of `navigate('/recipes/123')`), which requires features to know about other feature's routes. Ideally each feature should be able to contribute to some react context, which then gets "injected" into that feature

Each feature has a `useApp()` hook, which is constructed by listing the dependencies of that feature.

```tsx
// src/features/recipe/index.ts

// These all need to come from context, so that in a test context this feature could be completely mocked.
const useApp = buildFeatureHook({
  depdencies: [
   useCalendarApi,
  ]
});

// This feature also provides it's own "public API"
export const useRecipeApi = ...
```