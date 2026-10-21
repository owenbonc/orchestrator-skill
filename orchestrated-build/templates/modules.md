# Module map and cross-module contracts

Each module is one import path (e.g. `@project/core/<module>`). Apps import from module paths only. Anything a browser or extension bundles stays free of server-only imports.

The foundation creates every module. Modules owned by later agents start as **stubs with these exact exported signatures**, each throwing `not implemented: <fn>`. The owner agent replaces them. A signature change must update every visible caller and be reported.

| Module | Owner | Exports (exact signatures) |
|---|---|---|
| `contracts` | foundation | schemas + inferred types for every API request/response and shared enum |
| `env` | foundation | parsed env with every var optional; `envStatus()` |
| `db` | foundation | `getDb()`, `schema`, `migrate()`, `useTestDb()` |
| `<module>` | `<agent>` | `<fn>(…): …` |

## File ownership

- **foundation**: root config, `contracts`, `env`, `db`, shared services, the stubs, app skeletons.
- **<agent>**: `<paths>`

## What the foundation actually shipped

<The orchestrator fills this in after reviewing the foundation's report. It overrides the table above.>

- Migrations: avoid schema changes in parallel agents. If one is needed, generate it and flag it loudly; the orchestrator regenerates migrations when merging.
