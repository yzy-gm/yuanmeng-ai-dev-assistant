# Yuanmeng AI Dev Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and fully verify an independent VSCode companion extension plus local CLI that indexes official Yuanmeng exports and Lua projects without modifying the official extension or leaking map-private data.

**Architecture:** One strict TypeScript package contains a VSCode-free core, narrow official-command/file adapters, a VSCode presentation layer, and a bundled Node CLI. The extension invokes dynamically discovered official commands and observes generated files; the CLI reads the same workspace JSON and requests UI refresh through a tokenized, expiring, file-based queue.

**Tech Stack:** TypeScript 5.9, system Node.js >=20 for development/CLI, the actual VSCode 1.70 Extension Host Node runtime for extension/core, VSCode API 1.70, esbuild, Vitest, `@vscode/test-electron`, `@vscode/vsce`, `luaparse`, `yaml`, npm.

**Spec:** `docs/superpowers/specs/2026-08-19-yuanmeng-ai-dev-assistant-design.md`

## Global Constraints

- Work only in the repository root returned for this independent task; never write to any existing Yuanmeng map project.
- Product source, fixtures, commits, reports, VSIX, and GitHub history contain no user map IDs, coordinates, signals, names, logs, code, official binaries, or official copyrighted assets.
- TypeScript uses `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noImplicitOverride`.
- System Node.js is `>=20` only for development, tests, packaging, and the standalone CLI. Extension/core code runs on VSCode's embedded Extension Host Node, targets `node16.13`, uses Node 16 typings, and is exercised inside VSCode 1.70.3; CLI output targets `node20`.
- Installing the VSIX never modifies PATH and never requires a global npm package; every initialized project receives an ignored, hash-verifying `.yuanmeng-inspector/bin/ymai.cmd` plus `cli-launcher.json`.
- Runtime dependencies are limited to `luaparse` and `yaml`; every additional dependency requires a documented purpose and license review before it is added.
- Lua is parsed to AST and never executed.
- Official capabilities are discovered with `commands.getCommands`; no hard `extensionDependencies`, official UDP client, official port binding, patch, copy, or redistribution is allowed.
- Every code write, ID replacement, property write, property push, and script build requires a VSCode preview/confirmation; the file request queue accepts only `refresh-ui`.
- Static/unit, CLI E2E, Extension Host, VSIX clean-profile, official editor single-player, and multiplayer evidence are recorded separately.
- No product code is written until the user explicitly approves the design and this plan.
- The source repository is public, but source visibility does not grant an open-source license. `package.json` uses `license: "UNLICENSED"`; `LICENSE` and `NOTICE.md` reserve all rights to 不见星光, while `THIRD_PARTY_NOTICES.md` states only third-party terms.

---

## Planned File Map

```text
package.json                         VSCode manifest, scripts, CLI bin, exact dependencies
package-lock.json                    reproducible npm dependency graph
tsconfig.json                        strict shared TypeScript compilation rules
eslint.config.mjs                    TypeScript lint rules
esbuild.mjs                          extension, CLI, and Extension Host test bundles
.gitignore                           build, work, VSIX, map-data, and token exclusions
.vscodeignore                        VSIX allow/deny list
src/core/model.ts                    canonical domain contracts and enums
src/core/errors.ts                   stable product errors and next actions
src/core/clock.ts                    injectable clock
src/core/hash.ts                     SHA-256 and stable JSON helpers
src/core/fs.ts                       filesystem interface and atomic storage
src/core/lua/literal-parser.ts       safe Lua literal AST evaluator
src/core/project/context.ts          project discovery, identity, fingerprints
src/core/status/status.ts            online/offline/fresh/stale state reducer
src/core/launcher/manifest.ts        CLI launcher manifest and binding validation
src/core/ui/adapter.ts               official schema gate plus synthetic-only test adapter
src/core/ui/index.ts                 normalized UI tree and search indexes
src/core/ui/diff.ts                  deterministic snapshot diff
src/core/ui/export.ts                JSON, CSV, Markdown rendering
src/core/registry/store.ts           ID/signal registry and transactions
src/core/lua/source-index.ts         Lua symbol, call, string, and ID reference index
src/core/api/declaration-index.ts    official declaration parser/search/diff
src/core/diagnostics/analyzer.ts     cross-domain diagnostics
src/core/patch/proposal.ts           patch preview, backup, apply, undo contracts
src/core/generation/templates.ts     API-backed Lua generators
src/core/property/workflow.ts        property snapshot/edit/push state machine
src/core/build/workflow.ts           official build observation state machine
src/core/audit/report.ts             health, acceptance, and handoff reports
src/core/logs/parser.ts              imported log parsing and aggregation
src/integrations/official/commands.ts official command capability adapter
src/integrations/official/files.ts   stable export/build/property file observer
src/integrations/official/api-source.ts official extension declaration discovery
src/integrations/queue/protocol.ts    session, request, and result file protocol
src/extension/extension.ts            activate/deactivate and composition root
src/extension/workspaces.ts           multi-root WorkspaceContextManager
src/extension/commands.ts             command registration and confirmations
src/extension/views.ts                native TreeView providers
src/extension/status-bar.ts           status bar rendering
src/extension/language-features.ts    diagnostics, hover, CodeLens, Quick Fix
src/extension/virtual-documents.ts    read-only diff preview documents
src/extension/wizard.ts               Chinese onboarding workflow
src/extension/cli-launcher.ts         atomic per-project launcher generation/refresh
src/cli/main.ts                       `ymai` entry point and command routing
src/cli/args.ts                       zero-dependency option parsing
src/cli/output.ts                     human/JSON envelope output and exit codes
src/cli/project.ts                    CLI project root resolution
media/yuanmeng-ai.svg                 original product-owned activity icon
media/yuanmeng-ai.png                 256px Marketplace icon derived from the product-owned glyph
package.nls.json                      default Chinese strings
package.nls.en.json                   English fallback strings
schemas/*.schema.json                 product-owned JSON Schemas
test/unit/**/*.test.ts                core failure-first tests
test/integration/**/*.test.ts         filesystem, queue, and CLI process tests
test/extension/**/*.test.ts           Extension Host behavior tests
test/fixtures/**                      anonymous generated fixtures only
scripts/*.mjs                         verify, privacy, VSIX, and acceptance runners
README.md                             install, uninstall, quick start, privacy, limits
CHANGELOG.md                          versioned changes
NOTICE.md                             public-source copyright/no-open-license notice
THIRD_PARTY_NOTICES.md                packaged dependency licenses
```

## Requirement Traceability

| Required area | Implemented and verified by |
|---|---|
| A. Environment and official linkage | Tasks 4, 6, 8, 14, 19 |
| B. Complete UI index | Tasks 3, 5, 7, 8, 17, 19 |
| C. ID and signal registry | Tasks 2, 9, 10, 12, 17, 19 |
| D. Custom properties | Tasks 6, 13, 15, 19 |
| E. Official Lua API | Tasks 11, 12, 13 |
| F. Lua understanding/navigation | Tasks 10, 12, 16 |
| G. Safe generation | Tasks 11, 13, 19 |
| H. Build/audit/testing | Tasks 12, 14, 16, 17, 18, 19 |
| I. Log diagnostics | Task 16 |
| J. AI/CLI interface | Tasks 2, 6–9, 11, 12, 16–19 |
| K. Chinese UX and multi-root isolation | Tasks 4, 8, 12, 18 |
| Privacy, packaging, GitHub | Tasks 1, 18, 19 |

## Task 1: Repository and Executable Test Baseline

**Milestone:** M0

**Files:**
- Create: `.gitignore`
- Create: `.vscodeignore`
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `tsconfig.extension.json`
- Create: `tsconfig.cli.json`
- Create: `eslint.config.mjs`
- Create: `esbuild.mjs`
- Create: `scripts/check-system-node.mjs`
- Create: `src/extension/extension.ts`
- Create: `src/cli/main.ts`
- Create: `test/unit/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `typecheck`, `typecheck:extension`, `typecheck:cli`, `lint`, `test:unit`, `test:integration`, `test:extension`, `build`, `verify`, `package:vsix`.
- Produces: extension entry `activate(context: vscode.ExtensionContext): Promise<void>` and CLI `main(argv: string[]): Promise<number>`.

- [x] **Step 1: Verify the isolated Git boundary created for the approved documents**

Run:

```powershell
git rev-parse --show-toplevel
git status --short
```

Expected: the repository root is the current independent directory, commit `docs: design yuanmeng ai dev assistant` is present, and no files from another project appear.

- [x] **Step 2: Write the failing smoke test**

```ts
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '../../src/core/model.js';

describe('product identity', () => {
  it('uses the independent companion name', () => {
    expect(PRODUCT_NAME).toBe('Yuanmeng AI Dev Assistant');
  });
});
```

- [x] **Step 3: Add exact toolchain configuration**

`package.json` must set `name: "yuanmeng-ai-dev-assistant"`, `version: "0.1.0"`, `private: true`, `publisher: "bujianxingguang"`, `author: "不见星光"`, the exact first-screen description `由不见星光开发，为《元梦之星》创作者提供本地 UI、ID、Lua 与 API 检查能力的 VS Code 伴随工具。`, `license: "UNLICENSED"`, `pricing: "Free"`, Chinese and English search keywords, `main: "./out/extension.cjs"`, `bin.ymai: "./out/cli.cjs"`, `engines.vscode: "^1.70.0"`, and `engines.node: ">=20"`. `private: true` prevents accidental npm publication; it does not describe Visual Studio Marketplace visibility. The Node manifest boundary applies to development and the standalone CLI; the Extension Host bundle remains compatible with VSCode 1.70's embedded Node 16. `bin.ymai` is npm metadata for development only and is never presented as the VSIX installation mechanism. Pin `luaparse@0.3.1` and security-fixed `yaml@2.9.0`; pin dev dependencies `typescript@5.9.3`, root `@types/node@20.19.17` for Vitest's declared peer and CLI/test tooling, alias `@types/node16` to `npm:@types/node@16.18.126` for the isolated extension graph, `@types/vscode@1.70.0`, `@types/luaparse@0.2.13`, `esbuild@0.25.10`, `vitest@4.0.0`, direct `vite@7.1.12` to prevent the Vitest 4.0.0 transport from resolving to the incompatible Vite 7.3 protocol, `eslint@9.36.0`, `typescript-eslint@8.44.1`, `@vscode/test-electron@2.5.2`, and `@vscode/vsce@3.6.2`. Vite is MIT-licensed and development-only.

Create `tsconfig.extension.json` with `types: ["node16", "vscode"]` for `src/core`, `src/integrations`, and `src/extension`; create `tsconfig.cli.json` with `types: ["node"]` for the CLI entry. Build `extension.cjs` with esbuild target `node16.13` and `cli.cjs` with target `node20`. Add a boundary lint rule that rejects imports from `src/cli` into extension/core and rejects the enumerated Node 20-only APIs in the extension graph. A preflight script rejects system Node below 20 before development commands, while the packaged extension never runs that system-Node check inside the Extension Host.

Run:

```powershell
npm install
npm run test:unit -- test/unit/smoke.test.ts
```

Expected: the first test run fails because `src/core/model.ts` does not exist.

- [x] **Step 4: Add the minimal product identity and empty composition roots**

```ts
export const PRODUCT_NAME = 'Yuanmeng AI Dev Assistant' as const;
export const PRODUCT_DISPLAY_NAME = '元梦 AI 开发助手' as const;
export const SCHEMA_VERSION = 1 as const;
```

The extension activation must register nothing yet and the CLI must return exit code 7 with a Chinese usage message for an empty argv.

- [x] **Step 5: Verify the baseline**

Run:

```powershell
npm run typecheck
npm run lint
npm run test:unit -- test/unit/smoke.test.ts
npm run build
```

Expected: all commands exit 0; `out/extension.cjs` and `out/cli.cjs` exist; no files are created outside this repository.

- [x] **Step 6: Commit**

```powershell
git add .gitignore .vscodeignore package.json package-lock.json tsconfig.json tsconfig.extension.json tsconfig.cli.json eslint.config.mjs esbuild.mjs scripts/check-system-node.mjs src test docs
git commit -m "chore: establish strict extension baseline"
```

## Task 2: Domain Contracts, Errors, Hashing, and Atomic Storage

**Milestone:** M0

**Files:**
- Create: `src/core/model.ts`
- Create: `src/core/errors.ts`
- Create: `src/core/clock.ts`
- Create: `src/core/hash.ts`
- Create: `src/core/fs.ts`
- Create: `src/core/launcher/manifest.ts`
- Create: `schemas/status.schema.json`
- Create: `schemas/ui-snapshot.schema.json`
- Create: `schemas/registry.schema.json`
- Create: `schemas/cli-launcher.schema.json`
- Test: `test/unit/model.test.ts`
- Test: `test/integration/atomic-storage.test.ts`
- Test: `test/unit/launcher-manifest.test.ts`

**Interfaces:**
- Produces: the exact interfaces and enums from spec sections 6.1–6.5, including independent `RegistryEnvironment` and `RegistryValidity` fields.
- Produces: `ProductError`, `sha256Hex`, `stableJson`, `atomicWriteJson`, `readJsonValidated`.
- Produces: `CliLauncherManifest` and `validateLauncherBinding(manifest, invocation): LauncherBinding`.

- [x] **Step 1: Write failing contract and storage tests**

```ts
it('does not replace a valid file when validation fails', async () => {
  await fs.writeFile(target, '{"schemaVersion":1,"ok":true}');
  await expect(atomicWriteJson(io, target, { schemaVersion: 2 }, validateV1)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await fs.readFile(target, 'utf8')).toContain('"ok":true');
});

it('serializes object keys deterministically', () => {
  expect(stableJson({ z: 1, a: 2 })).toBe('{\n  "a": 2,\n  "z": 1\n}\n');
});
```

- [x] **Step 2: Run RED**

Run:

```powershell
npm run test:unit -- test/unit/model.test.ts
npm run test:unit -- test/unit/launcher-manifest.test.ts
npm run test:integration -- test/integration/atomic-storage.test.ts
```

Expected: failures report missing exports.

- [x] **Step 3: Implement the contracts and stable errors**

```ts
export class ProductError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly nextActions: readonly string[],
    readonly evidence: EvidenceLevel,
    readonly cause?: unknown,
  ) { super(message); }
}

export async function atomicWriteJson<T>(
  io: FileIO,
  target: string,
  value: T,
  validate: (value: unknown) => asserts value is T,
): Promise<void>;

export type RegistryEnvironment = 'test' | 'formal' | 'unspecified';
export type RegistryValidity = 'pending' | 'confirmed' | 'invalid' | 'suspected-change';

export interface RegistryRecord {
  recordId: string;
  kind: RegistryKind;
  environment: RegistryEnvironment;
  validity: RegistryValidity;
  projectInstanceId: string;
  mapFingerprint: string | null;
}

export interface CliLauncherManifest {
  schemaVersion: 1;
  extensionId: 'bujianxingguang.yuanmeng-ai-dev-assistant';
  extensionVersion: string;
  extensionRootHash: string;
  cliPath: string;
  cliSha256: string;
  projectInstanceId: string;
  projectRootHash: string;
  generatedAt: string;
}
```

Use same-directory temporary files, flush, close, and rename. Retry Windows rename collisions five times with delays 50/100/200/400/800 ms. Never delete the previous valid target before replacement succeeds.

- [x] **Step 4: Add orthogonal registry and JSON Schema parity tests**

Verify every TypeScript enum value appears in the corresponding product-owned Schema and that unknown enum values fail with `VALIDATION_FAILED`. Enumerate all 12 `environment × validity` combinations, including `test + confirmed` and `formal + suspected-change`, and require each to round-trip through registry JSON. Verify `cli-launcher.schema.json` requires extension/project identity, target path, target SHA-256, extension-root hash, and generated timestamp.

- [x] **Step 5: Run GREEN**

Run:

```powershell
npm run typecheck
npm run test:unit -- test/unit/model.test.ts
npm run test:unit -- test/unit/launcher-manifest.test.ts
npm run test:integration -- test/integration/atomic-storage.test.ts
```

Expected: all selected tests pass.

- [x] **Step 6: Commit**

```powershell
git add src/core schemas test/unit/model.test.ts test/unit/launcher-manifest.test.ts test/integration/atomic-storage.test.ts
git commit -m "feat: define versioned inspector contracts"
```

## Task 3: Non-Executing Lua Literal Parser

**Milestone:** M0

**Files:**
- Create: `src/core/lua/literal-parser.ts`
- Create: `test/unit/lua-literal-parser.test.ts`
- Create: `test/fixtures/lua/literal-ui.lua`
- Create: `test/fixtures/lua/unsafe-call.lua`
- Create: `test/fixtures/lua/damaged.lua`

**Interfaces:**
- Produces: `parseLuaLiteralDocument(source: string, options?: LuaParseLimits): LuaLiteralDocument`.
- Produces: source ranges for every literal and table entry; never evaluates code.

- [x] **Step 1: Write the allowlist and rejection tests**

```ts
it('parses only a returned nested literal table', () => {
  const doc = parseLuaLiteralDocument('return { name = "经验", id = 41001, visible = true, offset = -2 }');
  expect(doc.value).toEqual({ name: '经验', id: 41001, visible: true, offset: -2 });
});

it.each([
  'return os.execute("whoami")',
  'return factory()',
  'local x = 1; return {x}',
  'return { value = a.b }',
])('rejects executable or referenced Lua: %s', (source) => {
  expect(() => parseLuaLiteralDocument(source)).toThrowError(expect.objectContaining({ code: 'UNSAFE_LUA_NODE' }));
});
```

- [x] **Step 2: Run RED**

Run: `npm run test:unit -- test/unit/lua-literal-parser.test.ts`  
Expected: FAIL because the parser is missing.

- [x] **Step 3: Implement the AST allowlist**

Use `luaparse.parse(source, { locations: true, ranges: true, luaVersion: '5.3' })`. Accept only one return value containing table/string/numeric/boolean/nil literals and unary numeric minus. Reject calls, identifiers as values, assignments, functions, loops, conditionals, member/index reads, arithmetic and concatenation.

- [x] **Step 4: Add resource limit and encoding cases**

Tests must cover 16 MiB input, 200,000 nodes, depth 256, 4 MiB string, duplicate table keys, non-finite numbers, damaged syntax, BOM, and invalid UTF-8 decoded by the file adapter.

- [x] **Step 5: Run GREEN and leak check**

Run:

```powershell
npm run test:unit -- test/unit/lua-literal-parser.test.ts
rg -n "[A-Za-z]:\\\\" test src
```

Expected: tests pass and the search has no matches.

- [x] **Step 6: Commit**

```powershell
git add src/core/lua test/unit/lua-literal-parser.test.ts test/fixtures/lua
git commit -m "feat: safely parse literal-only Lua exports"
```

## Task 4: Project Discovery, Identity, and Status Reduction

**Milestone:** M1

**Files:**
- Create: `src/core/project/context.ts`
- Create: `src/core/status/status.ts`
- Create: `test/unit/project-context.test.ts`
- Create: `test/unit/status.test.ts`
- Create: `test/fixtures/projects/alpha/src/GameEntry.lua`
- Create: `test/fixtures/projects/beta/src/GameEntry.lua`

**Interfaces:**
- Produces: `discoverProjects(roots: readonly string[], io: FileIO): Promise<ProjectCandidate[]>`.
- Produces: `buildProjectIdentity(input: ProjectIdentityInput): ProjectIdentity`.
- Produces: `reduceStatus(input: StatusInput): InspectorStatus`.

- [x] **Step 1: Write failing isolation tests**

```ts
it('never merges two workspace roots', async () => {
  const projects = await discoverProjects([alphaRoot, betaRoot], io);
  expect(projects.map((x) => x.root)).toEqual([alphaRoot, betaRoot]);
  expect(projects[0]?.projectInstanceId).not.toBe(projects[1]?.projectInstanceId);
});

it('does not claim online from command presence alone', () => {
  expect(reduceStatus({ commandsPresent: true, refreshAttempt: null, snapshot: null }).link.state).toBe('unknown');
});
```

- [x] **Step 2: Run RED**

Run: `npm run test:unit -- test/unit/project-context.test.ts test/unit/status.test.ts`  
Expected: missing module failures.

- [x] **Step 3: Implement exact project and fingerprint rules**

Generate a UUID once in `.yuanmeng-inspector/meta.json`; store only the SHA-256 of the canonical root. Compute map fingerprint only with actual map name and sorted layer ID/name pairs. Reject a folder without both `src` and `src/GameEntry.lua`.

- [x] **Step 4: Implement freshness rules**

Mark stale for age over 30 minutes, source hash mismatch, timed-out refresh, extension-version change, or map fingerprint mismatch. A successful current request plus parsed stable files is the only path to fresh/online.

- [x] **Step 5: Verify**

Run: `npm run test:unit -- test/unit/project-context.test.ts test/unit/status.test.ts`  
Expected: all cases pass, including clock-boundary tests with an injected clock.

- [x] **Step 6: Commit**

```powershell
git add src/core/project src/core/status test/unit test/fixtures/projects
git commit -m "feat: isolate projects and evidence-aware status"
```

## Task 5: UI Adapter, Index, Search, Diff, and Export

**Milestone:** M1

**Files:**
- Create: `src/core/ui/adapter.ts`
- Create: `src/core/ui/index.ts`
- Create: `src/core/ui/diff.ts`
- Create: `src/core/ui/export.ts`
- Create: `test/unit/ui-adapter.test.ts`
- Create: `test/unit/ui-index.test.ts`
- Create: `test/unit/ui-diff.test.ts`
- Create: `test/unit/ui-export.test.ts`
- Create: `test/fixtures/ui/part1.lua`
- Create: `test/fixtures/ui/part2.lua`

**Interfaces:**
- Consumes: `parseLuaLiteralDocument`, `ProjectIdentity`, `SourceEvidence`.
- Produces: `adaptOfficialUiTables(parts)` as the production calibration gate and `adaptSyntheticUiTablesForTests(parts)` only for internal simulations.
- Produces: `buildUiSnapshot(input: UiSnapshotInput): UiSnapshot`.
- Produces: `findUi(snapshot, query, mode): UiSearchResult`.
- Produces: `diffUi(from, to): UiDiff` and `renderUiExport(snapshot, format): string`.

- [x] **Step 1: Calibrate the official export shape with a disposable privacy-safe project**

After implementation approval, use a newly created disposable editor project containing only user-authorized fictional controls. The names `HUD`, `经验`, and `结算` are examples, not a required layout. Trigger the official UI export, inspect the raw shape read-only, and record only field names, nesting rules, value types, multi-file semantics, extension version, and anonymous structure hashes. Do not copy the raw export or its real generated IDs into this repository. Recreate the observed shape manually with fictional IDs in dedicated anonymous fixtures. If the editor step is unavailable, mark this task blocked at the adapter boundary; do not claim the synthetic format is current official behavior.

Execution note (2026-08-20): **calibrated**. The user created and authorized a disposable test UI and linked the ignored `work/editor-calibration` project. Dream Helper 1.4.7 wrote both a name-keyed projection and a duplicate-safe indexed projection. The current production adapter uses only the indexed `_1`…`_n` / `_uid` / `_name` representation, reports the unexported type as `unknown`, and rejects unknown structures. Raw values remain ignored; `official-v1-keyed.lua` and `official-v1-indexed.lua` are anonymous manual reconstructions. Detailed evidence is in `docs/evidence/2026-08-20-m1-correction-status.md`.

- [x] **Step 2: Write failing unique/ambiguous search tests**

```ts
it('returns the only exact Chinese name', () => {
  expect(findUi(snapshot, '经验', { mode: 'exact-name' })).toMatchObject({ kind: 'unique', node: { id: '41001', path: '/HUD/经验' } });
});

it('never silently selects duplicate names', () => {
  const result = findUi(duplicateSnapshot, '经验', { mode: 'exact-name' });
  expect(result).toEqual({ kind: 'ambiguous', candidates: expect.arrayContaining([
    expect.objectContaining({ path: '/HUD/经验' }),
    expect.objectContaining({ path: '/结算/经验' }),
  ]) });
});
```

- [x] **Step 3: Write failing five-category diff tests**

Construct two synthetic snapshots and assert `added`, `removed`, `renamed`, `moved`, and `idChanged`. Add a collision that must appear in `ambiguousPotentialChanges` while remaining added/removed.

- [x] **Step 4: Run RED**

Run: `npm run test:unit -- test/unit/ui-*.test.ts`  
Expected: missing UI modules.

- [x] **Step 5: Implement deterministic adapter and indexes**

The synthetic test adapter accepts only the explicitly fictional legacy fixture contract, retains source file/range, escapes path components using `~0`/`~1`, rejects duplicate IDs, and sorts by path then ID. Unknown synthetic shapes return `UNSUPPORTED_UI_SCHEMA` with key summary and structure hash. After Step 1, the production adapter accepts only the calibrated indexed projection, uses `unknown` for the absent type field, and rejects missing/unknown shapes without guessing.

- [x] **Step 6: Implement diff and exports**

Use same-ID matching first; use unique `(type, parent-name-lineage, name)` matching only for ID changes. Render stable JSON, UTF-8 BOM CSV, and Markdown. CSV cells use RFC 4180 quoting.

- [x] **Step 7: Verify**

Run:

```powershell
npm run test:unit -- test/unit/ui-adapter.test.ts test/unit/ui-index.test.ts test/unit/ui-diff.test.ts test/unit/ui-export.test.ts
```

Expected: all tests pass; snapshot output is byte-identical across two runs.

- [x] **Step 8: Commit**

```powershell
git add src/core/ui test/unit/ui-*.test.ts test/fixtures/ui
git commit -m "feat: index search and diff UI snapshots"
```

## Task 6: Official Capability Adapter, Stable File Observer, and Refresh Queue

**Milestone:** M1

**Files:**
- Create: `src/integrations/official/commands.ts`
- Create: `src/integrations/official/files.ts`
- Create: `src/integrations/queue/protocol.ts`
- Create: `test/unit/official-commands.test.ts`
- Create: `test/integration/stable-files.test.ts`
- Create: `test/integration/request-queue.test.ts`

**Interfaces:**
- Produces: `OfficialCommandAdapter.detect(): Promise<OfficialCapabilities>`.
- Produces: `OfficialCommandAdapter.execute(command: OfficialCommand, ...args: unknown[]): Promise<void>`.
- Produces: `waitForStableExport(options): Promise<StableExportResult>`.
- Produces: `QueueSession`, `RefreshUiRequest`, `QueueResult`, and `RequestQueueHost`.

- [x] **Step 1: Write failing capability tests**

```ts
it('detects commands dynamically without an extension dependency', async () => {
  const adapter = new OfficialCommandAdapter(fakeCommands(['dreamhelper.GetCustomUIData']));
  expect(await adapter.detect()).toMatchObject({ refreshUi: true, build: false, startWork: false });
});
```

- [x] **Step 2: Write half-write and split-window tests**

Simulate a writer that writes half of `CustomUIData.lua`, waits, completes it, then writes `CustomUIData2.lua`. Assert three equal 150 ms samples, a 2 second split collection window, a 15 second total deadline, and preservation of the prior snapshot on parse failure.

- [x] **Step 3: Write queue security tests**

Test wrong token, expired request, duplicate request ID, wrong `projectInstanceId`, unknown action, non-atomic `.tmp` file, and a valid `refresh-ui`. Every rejected request must produce a result and must not call the official adapter.

- [x] **Step 4: Run RED**

Run:

```powershell
npm run test:unit -- test/unit/official-commands.test.ts
npm run test:integration -- test/integration/stable-files.test.ts test/integration/request-queue.test.ts
```

Expected: missing integration modules.

- [x] **Step 5: Implement the narrow adapters**

The only accepted queue action is the literal string `refresh-ui`. Generate a 256-bit token with `crypto.randomBytes(32)`, bind it to project/session, set a 60 second request TTL, and atomically write results. Never open a socket.

- [x] **Step 6: Verify**

Run the selected tests and `Get-NetUDPEndpoint | Where-Object LocalPort -ge 2356 | Select-Object -First 5`.  
Expected: tests pass; the product tests do not create or change a UDP listener.

- [x] **Step 7: Commit**

```powershell
git add src/integrations test/unit/official-commands.test.ts test/integration
git commit -m "feat: observe official exports without port interference"
```

## Task 7: CLI M1 Commands and Exit Codes

**Milestone:** M1

**Files:**
- Create: `src/cli/args.ts`
- Create: `src/cli/output.ts`
- Create: `src/cli/project.ts`
- Modify: `src/cli/main.ts`
- Test: `test/unit/cli-args.test.ts`
- Test: `test/integration/cli-m1.test.ts`

**Interfaces:**
- Consumes: status, UI snapshot/search/diff/export, queue protocol.
- Produces: `runCli(argv, deps): Promise<CliRunResult>` with codes 0/2/3/4/5/6/7/8.
- Consumes: a validated `--launcher-manifest` binding generated by the extension; a conflicting `--project` is rejected.

- [x] **Step 1: Write failing process tests for every exit class**

```ts
it.each([
  [['status', '--project', offlineProject, '--json'], 2, 'OFFLINE'],
  [['find-ui', '经验', '--project', staleProject, '--json'], 3, 'STALE'],
  [['find-ui', '经验', '--project', duplicateProject, '--json'], 4, 'AMBIGUOUS'],
  [['find-ui', '不存在', '--project', freshProject, '--json'], 5, 'NOT_FOUND'],
])('returns a stable exit code and JSON envelope', async ([argv, exitCode, code]) => {
  const result = await spawnCli(argv as string[]);
  expect(result.exitCode).toBe(exitCode);
  expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, code });
});
```

- [x] **Step 2: Run RED**

Run: `npm run test:integration -- test/integration/cli-m1.test.ts`  
Expected: CLI reports usage for commands not yet implemented.

- [x] **Step 3: Implement zero-dependency argument parsing and project resolution**

Support `status`, `refresh-ui`, `find-ui`, `diff-ui`, and `export`. When `--launcher-manifest` is present, validate projectInstanceId, project-root hash, extension ID/version/root hash, CLI real path, and CLI SHA-256 before accepting the binding. Reject a conflicting `--project` with exit 6. Without a launcher binding, development invocation may walk upward for exactly one `src/GameEntry.lua`; zero or multiple matches return exit 7. `--json` writes no decorative text to stdout.

- [x] **Step 4: Implement stale acknowledgement**

Without `--allow-stale`, a successful lookup on old data returns 3. With it, return 0 but retain `warnings: ['UI 数据陈旧']` and `data.freshness: 'stale'`.

- [x] **Step 5: Verify human and JSON modes**

Run:

```powershell
npm run build
node out/cli.cjs status --project test/fixtures/projects/alpha --json
npm run test:integration -- test/integration/cli-m1.test.ts
```

Expected: valid JSON on stdout, diagnostics only on stderr, all process assertions pass.

- [x] **Step 6: Commit**

```powershell
git add src/cli test/unit/cli-args.test.ts test/integration/cli-m1.test.ts
git commit -m "feat: expose UI inspection through ymai CLI"
```

## Task 8: VSCode Multi-Root Shell, UI Tree, Search Panel, Status Bar, and Wizard

**Milestone:** M1

**Files:**
- Create: `src/extension/workspaces.ts`
- Create: `src/extension/commands.ts`
- Create: `src/extension/views.ts`
- Create: `src/extension/status-bar.ts`
- Create: `src/extension/wizard.ts`
- Create: `src/extension/cli-launcher.ts`
- Modify: `src/extension/extension.ts`
- Modify: `package.json`
- Create: `package.nls.json`
- Create: `package.nls.en.json`
- Create: `media/yuanmeng-ai.svg`
- Create: `scripts/run-extension-tests.mjs`
- Test: `test/extension/m1-ui.test.ts`
- Test: `test/extension/cli-launcher.test.ts`
- Test: `test/extension/runtime-capabilities.test.ts`

**Interfaces:**
- Produces: `WorkspaceContextManager`, native view providers, atomic per-project CLI launchers, `yuanmengAi.refreshUi`, `yuanmengAi.findUi`, `yuanmengAi.openWizard`, and `yuanmengAi.copyCliCommand`.

- [x] **Step 1: Write failing Extension Host UI and runtime capability tests**

Register fake official commands in the test host. Open a two-root workspace and assert each root receives a distinct context, refresh affects only the selected root, duplicate search populates two path-labelled results, and the status bar never displays an empty field. In VSCode 1.70.3, record `process.versions.node` and execute core smoke operations for SHA-256, random bytes, atomic write/rename, Lua literal parsing, YAML parsing, and workspace context creation. The test must fail on an unavailable runtime primitive rather than consulting system `node --version`.

- [ ] **Step 2: Run RED on minimum VSCode**

Run:

```powershell
node scripts/run-extension-tests.mjs --version 1.70.3 --grep "M1 UI|runtime capabilities"
```

Expected: command/view assertions fail because contributions are absent.

Execution note (2026-08-20): exact VSCode 1.70.3 remains unavailable from the supported test download path, so this checkbox stays open. Same-generation 1.70.2 RED/GREEN evidence is tracked separately and must not be reported as 1.70.3.

- [x] **Step 3: Add manifest contributions and Chinese defaults**

Contribute the `yuanmengAi` activity container, environment/UI/search/problem views, commands, settings from spec section 10, and activation on `onStartupFinished`. Use only APIs present in `@types/vscode@1.70.0`.

- [x] **Step 4: Write failing launcher lifecycle tests**

Use extension roots and project roots containing spaces and Chinese characters. In the Extension Host, assert initial creation, byte-stable regeneration, an extension upgrade represented by a changed version plus relocated extension root, path/hash refresh, argument forwarding, missing system Node, Node major below 20, missing CLI after uninstall, CLI hash mismatch, target outside extension root, and project-binding mismatch. Missing/uninstalled target must print `元梦 AI 开发助手已卸载或安装路径失效`, exit 2, and never invoke Node on the target; hash/root mismatch exits 6.

- [x] **Step 5: Implement atomic, hash-verifying project launchers**

Create `.yuanmeng-inspector/bin/cli-launcher.json` and `ymai.cmd` with same-directory temporary files, flush, and rename. The cmd launcher embeds the expected resolved CLI path and SHA-256, uses a fixed PowerShell verifier with `Get-FileHash`, never uses `Invoke-Expression`, validates the JSON and real path, checks system Node major >=20, then invokes the verified values as an argument array equivalent to `& $nodeExe $verifiedCliPath '--launcher-manifest' $verifiedManifestPath '--project' $boundProjectRoot @forwardedArgs`. Regenerate when extension version, root, CLI hash, project identity, or project-root hash changes. Do not modify PATH.

- [x] **Step 6: Implement multi-root routing, native views, and copy command**

Resolve the active editor's folder first; otherwise show QuickPick. Search results are a dedicated TreeView, not a fake Webview. Context actions copy ID/path/Lua constant. The wizard enforces the five ordered gates from the spec.

The wizard's CLI step initializes or refreshes the launcher and copies exactly `& ".\.yuanmeng-inspector\bin\ymai.cmd" status --json` for the selected project. `cli-launcher.json` is the machine-readable discovery record for Codex.

- [ ] **Step 7: Verify minimum and current stable hosts**

Run:

```powershell
node scripts/run-extension-tests.mjs --version 1.70.3 --grep "M1 UI|runtime capabilities|CLI launcher"
node scripts/run-extension-tests.mjs --version stable --grep "M1 UI|runtime capabilities|CLI launcher"
```

Expected: both runs pass.

Execution note (2026-08-20): 1.70.2 records embedded Node 16.13.2 and passes the Extension Host simulation/runtime/launcher suites. A standalone probe that never activates this product reproduces 1.70.2's `installAndRestartMessage` noise after writing a `.lua` file; the successful product run no longer emits `path argument undefined` or `Cannot call write after a stream was destroyed`. Stable-host verification is rerun before Task 8 commit, while the exact 1.70.3 half of this checkbox remains open.

- [x] **Step 8: Commit**

```powershell
git add package.json package.nls*.json media src/extension test/extension scripts/run-extension-tests.mjs
git commit -m "feat: add multi-root UI inspection experience"
```

Execution note (2026-08-20): completed by commit `4e5ee98`.

## Task 9: Map-Scoped ID and Signal Registry

**Milestone:** M2

**Files:**
- Create: `src/core/registry/store.ts`
- Create: `test/unit/registry.test.ts`
- Create: `test/integration/registry-import.test.ts`
- Create: `test/fixtures/registry/valid.json`
- Create: `test/fixtures/registry/valid.yaml`
- Create: `test/fixtures/registry/valid.csv`
- Modify: `src/extension/views.ts`
- Modify: `src/extension/commands.ts`
- Modify: `src/cli/main.ts`

**Interfaces:**
- Produces: `RegistryStore.list({ kind?, environment?, validity? })`, `previewImport`, `commitImport`, `syncUiSnapshot`, `markSuspectedChanges`, and `propertyEligibility`.
- Produces: CLI `list-ids` and UI registry view.

- [x] **Step 1: Write failing orthogonal state and map guard tests**

```ts
it('never promotes a test ID to formal during UI sync', async () => {
  const result = await store.syncUiSnapshot(freshSnapshot, [testRecord]);
  expect(result.records.find((x) => x.recordId === testRecord.recordId)).toMatchObject({
    environment: 'test',
    validity: 'confirmed',
  });
});

it('excludes a record from a different map fingerprint', () => {
  expect(store.usableForMap('map-b')).not.toContainEqual(expect.objectContaining({ mapFingerprint: 'map-a' }));
});

it('allows a user-entered test target when official map identity is unavailable', () => {
  expect(store.propertyEligibility({
    projectInstanceId: 'project-a',
    mapFingerprint: null,
    records: [userTestLayer, userUnspecifiedInstance],
  })).toMatchObject({ allowed: true, warning: '地图身份未由官方确认' });
});
```

Enumerate all 12 `RegistryEnvironment × RegistryValidity` combinations. Assert `formal + suspected-change` preserves formal during refresh, auto-created UI records use unspecified, and no action other than an explicit user-confirmed environment change can produce formal.

- [x] **Step 2: Write transactional import failures**

Duplicate IDs, invalid environment, invalid validity, mixed map fingerprints, malformed CSV quoting, and a bad YAML row must leave the original registry byte-identical. JSON/YAML/CSV round trips must preserve both fields independently.

For `mapFingerprint=null`, add negative eligibility cases for cross-project records, environment formal, validity invalid/suspected-change, non-user-entry sources, multiple layers, and multiple instances. All must be rejected without modifying either record.

- [x] **Step 3: Run RED**

Run: `npm run test:unit -- test/unit/registry.test.ts; npm run test:integration -- test/integration/registry-import.test.ts`  
Expected: missing registry store.

- [x] **Step 4: Implement registry transactions and formats**

Parse JSON directly, YAML through `yaml`, and CSV with a small RFC 4180 parser owned by the project. Always return a preview diff before `commitImport`. Auto-sync only UI IDs; scene instances require user/property workflow input.

- [x] **Step 5: Add UI and CLI read paths**

`list-ids` supports exact `--kind`, `--environment`, and `--validity`; `--status` is not accepted. VSCode import uses file picker, validation summary, two-dimensional diff preview, and explicit confirmation.

- [x] **Step 6: Verify and commit**

Run: `npm run test:unit -- test/unit/registry.test.ts; npm run test:integration -- test/integration/registry-import.test.ts`  
Expected: all tests pass.

```powershell
git add src/core/registry src/extension src/cli test
git commit -m "feat: add map-scoped ID and signal registry"
```

## Task 10: Lua Source Index and Where-Used

**Milestone:** M2

**Files:**
- Create: `src/core/lua/source-index.ts`
- Create: `test/unit/lua-source-index.test.ts`
- Create: `test/fixtures/source-project/src/GameEntry.lua`
- Create: `test/fixtures/source-project/src/Feature.lua`
- Modify: `src/cli/main.ts`

**Interfaces:**
- Produces: `buildLuaSourceIndex(files, registry, apiIndex): LuaSourceIndex`.
- Produces: `whereUsed(index, query): WhereUsedResult[]`.
- Produces: CLI `where-used`.

- [x] **Step 1: Write failing false-positive and reference tests**

```ts
it('does not classify arbitrary numbers as IDs', () => {
  const index = buildLuaSourceIndex([{ path: 'Feature.lua', source: 'local retry = 3' }], emptyRegistry, emptyApi);
  expect(index.idReferences).toEqual([]);
});

it('finds a registered UI ID and a signal candidate with source ranges', () => {
  const result = buildLuaSourceIndex(files, registryWith41001, apiIndex);
  expect(result.idReferences[0]).toMatchObject({ value: '41001', confidence: 'confirmed' });
  expect(result.stringLiterals).toContainEqual(expect.objectContaining({ value: 'round_started' }));
});
```

- [x] **Step 2: Run RED**

Run: `npm run test:unit -- test/unit/lua-source-index.test.ts`  
Expected: missing source index.

- [x] **Step 3: Implement syntax-only indexing**

Index files, returned modules, local/global functions, calls, requires, literals and config fields. Mark an ID only on registry match, confirmed API ID parameter, or configured ID field. Assign client/server evidence from calls/callbacks/annotations, never filename alone.

- [x] **Step 4: Implement where-used and CLI formatting**

Return relative path, 1-based line/column, context, kind, confidence and registry/API evidence. `--kind` accepts only `id`, `signal`, or `ui`.

- [x] **Step 5: Verify and commit**

Run: `npm run test:unit -- test/unit/lua-source-index.test.ts; npm run build; node out/cli.cjs where-used 41001 --project test/fixtures/source-project --json`  
Expected: tests pass and JSON contains no absolute user path.

```powershell
git add src/core/lua/source-index.ts src/cli/main.ts test
git commit -m "feat: index Lua references without numeric noise"
```

## Task 11: Official API Declaration Index and Change Detection

**Milestone:** M3

**Files:**
- Create: `src/core/api/declaration-index.ts`
- Create: `src/integrations/official/api-source.ts`
- Create: `test/unit/api-declaration-index.test.ts`
- Create: `test/integration/api-source.test.ts`
- Create: `test/fixtures/api/UI.d.lua`
- Create: `test/fixtures/api/UI-v2.d.lua`
- Modify: `src/cli/main.ts`

**Interfaces:**
- Produces: `parseDeclarationFile`, `buildApiIndex`, `searchApi`, `diffApiIndexes`.
- Produces: `discoverOfficialApiSource(extensions, overridePath): ApiSourceSelection`.
- Produces: CLI `api-search`.

- [x] **Step 1: Write failing declaration/search tests**

```ts
it('indexes signature, params, returns, source hash and version', () => {
  const index = buildApiIndex([fixture], { officialExtensionVersion: '9.9.9-test' });
  expect(searchApi(index, '控件名称')[0]).toMatchObject({ module: 'UI', name: 'GetUIName', callStyle: 'colon' });
});

it('returns no invented result for an unknown API', () => {
  expect(searchApi(index, 'MakeEverythingWork')).toEqual([]);
});
```

- [x] **Step 2: Run RED**

Run: `npm run test:unit -- test/unit/api-declaration-index.test.ts`  
Expected: missing parser.

- [x] **Step 3: Implement declaration parsing and discovery**

Parse Emmy annotations and empty function declarations without executing Lua. Store only derived metadata, relative path, hash, version, signature and short description. Discover candidates through extension metadata and `res/lib/*.d.lua`; multiple candidates require a selection.

- [x] **Step 4: Add version diff and CLI tests**

Assert added, removed, parameter and return changes keyed by `module + callStyle + name`. CLI unknown search returns exit 5 and `NOT_FOUND`.

- [x] **Step 5: Verify and commit**

Run: `npm run test:unit -- test/unit/api-declaration-index.test.ts; npm run test:integration -- test/integration/api-source.test.ts`  
Expected: all tests pass and no official file content is copied into output snapshots.

```powershell
git add src/core/api src/integrations/official/api-source.ts src/cli/main.ts test
git commit -m "feat: index versioned official Lua declarations"
```

## Task 12: Diagnostics, Hover, CodeLens, Quick Fix, and Health Report

**Milestone:** M2/M3

**Files:**
- Create: `src/core/diagnostics/analyzer.ts`
- Create: `src/extension/language-features.ts`
- Create: `test/unit/diagnostics.test.ts`
- Create: `test/extension/language-features.test.ts`
- Modify: `src/extension/extension.ts`
- Modify: `src/cli/main.ts`

**Interfaces:**
- Produces: `analyzeProject(input): ProjectDiagnostic[]`.
- Produces: VSCode providers and CLI `audit`.

- [x] **Step 1: Write failing diagnostic precision tests**

Cover `environment=test` with `validity=confirmed`, `environment=formal` with `validity=suspected-change`, invalid ID, pending ID, cross-map ID, duplicate UI name, duplicate UI ID, unknown member on a known official module, wrong argument count, confirmable literal type mismatch, stale snapshot, and a plain number that must produce no ID diagnostic. Diagnostics must report environment and validity independently and must not describe a confirmed test ID as formal.

- [x] **Step 2: Run RED**

Run: `npm run test:unit -- test/unit/diagnostics.test.ts`  
Expected: missing analyzer.

- [x] **Step 3: Implement the analyzer**

Every diagnostic includes stable code, severity, source range, evidence, and next action. Unknown modules are not labelled unknown official APIs. Runtime verification is a separate field and defaults false.

- [x] **Step 4: Add VSCode providers**

Hover and CodeLens show registry name, environment, validity, scope, and map match as separate fields. Quick Fix actions are limited to opening records, selecting candidates, searching API, and creating a `PatchProposal`; none write directly.

- [x] **Step 5: Verify Extension Host and CLI**

Run:

```powershell
npm run test:unit -- test/unit/diagnostics.test.ts
node scripts/run-extension-tests.mjs --version stable --grep "language features"
npm run build
node out/cli.cjs audit --project test/fixtures/source-project --json
```

Expected: all pass; CLI issue counts equal the VSCode analyzer counts.

- [x] **Step 6: Commit**

```powershell
git add src/core/diagnostics src/extension src/cli/main.ts test
git commit -m "feat: add evidence-aware Lua diagnostics"
```

## Task 13: Patch Preview, Backup, Undo, and API-Backed Generators

**Milestone:** M3

**Files:**
- Create: `src/core/patch/proposal.ts`
- Create: `src/core/generation/templates.ts`
- Create: `src/extension/virtual-documents.ts`
- Create: `test/unit/patch-proposal.test.ts`
- Create: `test/unit/generation.test.ts`
- Create: `test/extension/patch-confirmation.test.ts`
- Modify: `src/extension/commands.ts`

**Interfaces:**
- Produces: `PatchProposal`, `createBackup`, `applyProposal`, `undoBackup`.
- Produces: `generateLua(request, apiIndex, registry): PatchProposal`.

- [x] **Step 1: Write failing safety tests**

```ts
it('refuses generation when the official signature is absent', () => {
  expect(() => generateLua(request, emptyApi, registry)).toThrowError(expect.objectContaining({ code: 'API_NOT_FOUND' }));
});

it('refuses a multiplayer template without callback-derived playerId evidence', () => {
  expect(() => generateLua(networkRequestWithoutCallback, api, registry)).toThrowError(expect.objectContaining({ code: 'PLAYER_ROUTING_UNCONFIRMED' }));
});

it('refuses to write official generated outputs', () => {
  expect(() => validateTarget('dist/play.lua')).toThrowError(expect.objectContaining({ code: 'GENERATED_FILE_PROTECTED' }));
});
```

- [x] **Step 2: Run RED**

Run: `npm run test:unit -- test/unit/patch-proposal.test.ts test/unit/generation.test.ts`  
Expected: missing proposal/generator modules.

- [x] **Step 3: Implement proposal and hash-guarded backup**

Store backups under `.yuanmeng-inspector/backups/<UTC timestamp>/<relative path>.bak` plus a manifest with original/new hashes. Apply only after caller confirmation. Undo refuses when current hash differs from the proposal's new hash.

- [x] **Step 4: Implement exact generators**

Support constants/config, button handler, visibility, text refresh, signal send and signal listen. Resolve every API by unique current signature. Templates interpolate selected values only; product sources contain no map IDs.

- [x] **Step 5: Add VSCode diff confirmation tests**

Use a read-only content provider plus `vscode.diff`. Assert Cancel makes no file, Confirm writes and backs up, and a second external change prevents undo.

- [x] **Step 6: Verify and commit**

Run: `npm run test:unit -- test/unit/patch-proposal.test.ts test/unit/generation.test.ts; node scripts/run-extension-tests.mjs --version stable --grep "patch confirmation"`  
Expected: all pass.

```powershell
git add src/core/patch src/core/generation src/extension test
git commit -m "feat: preview and guard Lua generation"
```

## Task 14: Official Script Build Observation

**Milestone:** M3

**Files:**
- Create: `src/core/build/workflow.ts`
- Create: `test/unit/build-workflow.test.ts`
- Create: `test/extension/build-command.test.ts`
- Modify: `src/extension/commands.ts`

**Interfaces:**
- Produces: `BuildWorkflow.prepare`, `confirmAndRun`, `observeResult`.
- Consumes: `dreamhelper.scriptGen` and stable file observer.

- [x] **Step 1: Write failing build state tests**

Assert command missing, user cancellation, 60 second timeout, unchanged artifact, `play.lua` change, `play.min.lua` change, and simultaneous changes. Artifact change yields `artifact-updated`, never `game-runtime-passed`.

- [x] **Step 2: Run RED**

Run: `npm run test:unit -- test/unit/build-workflow.test.ts`  
Expected: missing workflow.

- [x] **Step 3: Implement explicit confirmation and observation**

Before execution, display the official README warning that `dist` may be cleaned. Hash only existing target artifacts, execute the official command after confirmation, and observe stable updates without editing `dist` directly.

- [x] **Step 4: Verify Extension Host behavior**

Run: `node scripts/run-extension-tests.mjs --version stable --grep "build command"`  
Expected: Cancel never calls the fake official command; Confirm calls once; result language remains evidence-limited.

- [x] **Step 5: Commit**

```powershell
git add src/core/build src/extension/commands.ts test
git commit -m "feat: observe confirmed official script builds"
```

## Task 15: Custom Property Read, Diff, Literal Edit, and Two-Confirmation Push

**Milestone:** M4

**Files:**
- Create: `src/core/property/workflow.ts`
- Create: `test/unit/property-workflow.test.ts`
- Create: `test/extension/property-command.test.ts`
- Create: `test/fixtures/property/CustomProperty_7001_8001.lua`
- Modify: `src/extension/commands.ts`
- Modify: `src/extension/views.ts`

**Interfaces:**
- Produces: property target selection, snapshots, diffs, scalar source edits, and states `idle/read-requested/loaded/edit-previewed/file-written/push-requested/editor-verified`.

- [x] **Step 1: Write failing target and filename tests**

For a non-null current map fingerprint, require registered layer `7001`, instance `8001`, the same projectInstanceId and exact matching map fingerprint, validity pending/confirmed, and exact filename `CustomProperty_7001_8001.lua`. Reject path traversal, other map fingerprints, invalid/suspected-change validity, bulk lists, and a filename/record mismatch.

For a null current map fingerprint, allow exactly one layer and one instance only when both belong to the same projectInstanceId, both have `source.kind=user-entry`, each environment is test or unspecified, and each validity is pending or confirmed. Assert the returned workflow warning is exactly `地图身份未由官方确认`. Reject formal, invalid, suspected-change, cross-project, imported/auto sources, and multiple targets. Assert no successful null-fingerprint operation changes environment or promotes a record to formal.

- [x] **Step 2: Write failing edit and confirmation tests**

Assert only existing string/number/boolean/nil source ranges can change; tables and expressions are rejected. Assert file confirmation and push confirmation are separate events. `executeCommand` resolution produces `push-requested`, not `editor-verified`.

- [x] **Step 3: Run RED**

Run: `npm run test:unit -- test/unit/property-workflow.test.ts`  
Expected: missing property workflow.

- [x] **Step 4: Implement read workflow**

Copy/display `layerId;uid`, call `dreamhelper.GetCustomPropertyData`, explain that the official panel cannot be reliably prefilled through the public command, and observe the exact generated file with stable-write rules.

- [x] **Step 5: Implement literal edit and push workflow**

Create a patch proposal with backup and diff. After file write, show a second confirmation containing target, map fingerprint or the explicit null-fingerprint warning, project identity, file hash and summary; then call `dreamhelper.sendCustomPropertyData` with `vscode.Uri.file(path)`. Both confirmation screens retain `地图身份未由官方确认` when the fingerprint is null.

- [x] **Step 6: Verify and commit**

Run: `npm run test:unit -- test/unit/property-workflow.test.ts; node scripts/run-extension-tests.mjs --version stable --grep "property command"`  
Expected: all pass; no bulk push path exists.

```powershell
git add src/core/property src/extension test
git commit -m "feat: add confirmed custom property workflow"
```

## Task 16: Audit Reports and Imported Log Analysis

**Milestone:** M5

**Files:**
- Create: `src/core/audit/report.ts`
- Create: `src/core/logs/parser.ts`
- Create: `test/unit/audit-report.test.ts`
- Create: `test/unit/log-parser.test.ts`
- Create: `test/fixtures/logs/structured.log`
- Create: `test/fixtures/logs/mixed.log`
- Modify: `src/extension/commands.ts`
- Modify: `src/cli/main.ts`

**Interfaces:**
- Produces: `buildHealthReport`, `buildAcceptanceChecklist`, `buildHandoffReport`.
- Produces: `parseImportedLog`, `aggregateLog`.
- Adds CLI-internal `log-import` only if exposed in help and README; the mandatory CLI list remains stable.

- [x] **Step 1: Write failing evidence separation tests**

```ts
it('does not mark editor or multiplayer gates from local logs', () => {
  const report = buildAcceptanceChecklist({ unitPassed: true, importedLogs: [logEvidence], manualEvidence: [] });
  expect(report.gates.officialEditorSingle.status).toBe('unverified');
  expect(report.gates.officialEditorMulti.status).toBe('unverified');
});
```

- [x] **Step 2: Write log parsing tests**

Cover time range, level, player, request, signal, stage, malformed prefix, unknown line retention, UTF-8 BOM, and an explicit decoding failure. Aggregation must never invent a player for unlabelled lines.

- [x] **Step 3: Run RED**

Run: `npm run test:unit -- test/unit/audit-report.test.ts test/unit/log-parser.test.ts`  
Expected: missing report/log modules.

- [x] **Step 4: Implement reports and file import**

Generate deterministic JSON and Markdown sections for static/unit, Extension Host, VSIX, local logs, official editor single, and multiplayer. Add file picker and “import selected readable text” command. Internal VSCode log adapter remains disabled by default and requires a user-selected directory.

- [x] **Step 5: Verify and commit**

Run: `npm run test:unit -- test/unit/audit-report.test.ts test/unit/log-parser.test.ts`  
Expected: all tests pass and manual gates remain unverified without explicit records.

```powershell
git add src/core/audit src/core/logs src/extension src/cli test
git commit -m "feat: report health and classify imported evidence"
```

## Task 17: Complete CLI, Large-Data, Corruption, and Concurrency Acceptance

**Milestone:** M1–M5 integration

**Files:**
- Modify: `src/cli/main.ts`
- Create: `test/integration/cli-full.test.ts`
- Create: `test/integration/multi-project.test.ts`
- Create: `test/integration/large-ui.test.ts`
- Create: `scripts/generate-large-ui-fixture.mjs`
- Create: `scripts/verify-data-contracts.mjs`

**Interfaces:**
- Completes: `status`, `refresh-ui`, `find-ui`, `diff-ui`, `list-ids`, `audit`, `export`, `api-search`, `where-used` in human and JSON modes.

- [x] **Step 1: Add the complete CLI acceptance table**

For each mandatory command, test the development entry with `node out/cli.cjs` and the installed-project entry with `& ".\.yuanmeng-inspector\bin\ymai.cmd"` in human and JSON modes. Assert stdout format, stderr discipline, exit code, stale handling, relative paths, launcher binding, and zero leakage of the fixture root absolute path. `list-ids` must test independent `--environment` and `--validity` filters, every legal combination, and rejection of removed `--status`.

- [x] **Step 2: Add generated 100,000-node performance test**

Generate data during the test instead of committing a huge fixture. Measure parse/index time and RSS in a child process; assert <=5 seconds, <512 MiB RSS, and exact-search P95 <100 ms on the declared local acceptance machine. The current Windows run passed parse/index and P95 but measured RSS above 512 MiB; the RSS gate is explicitly `UNVERIFIED`, not a pass.

- [x] **Step 3: Add concurrency and corruption tests**

Run two project refresh queues concurrently; damage one Lua part, rotate the other's map fingerprint, and leave a third source half-written. Assert isolation, old-good snapshot preservation, and correct stale reason codes.

- [x] **Step 4: Run RED/GREEN integration**

Run:

```powershell
npm run build
npm run test:integration -- test/integration/cli-full.test.ts test/integration/multi-project.test.ts test/integration/large-ui.test.ts
node scripts/verify-data-contracts.mjs
```

Expected: CLI/concurrency checks pass; parse/index and exact-search thresholds pass; the RSS threshold is reported separately and remains unverified when the machine exceeds 512 MiB. Generated data is removed by the test runner from its temporary directory only. `verify-data-contracts.mjs` covers package/data contracts only; the full repository privacy audit belongs to Task 18.

- [x] **Step 5: Commit**

```powershell
git add src/cli test/integration scripts
git commit -m "test: cover complete CLI and large projects"
```

Execution note (2026-08-20): completed by commit `699b200`; RSS remains explicitly unverified as recorded in `docs/evidence/2026-08-20-task17-status.md`.

## Task 18: Documentation, Privacy Audit, VSIX, and Clean Profile

**Milestone:** M6

**Files:**
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `NOTICE.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `scripts/privacy-audit.mjs`
- Create: `scripts/inspect-vsix.mjs`
- Create: `scripts/build-upgrade-fixture.mjs`
- Create: `scripts/clean-profile-acceptance.ps1`
- Modify: `.vscodeignore`
- Modify: `package.json`
- Test: `test/integration/privacy-audit.test.ts`

**Interfaces:**
- Produces: `npm run verify`, `npm run package:vsix`, user-facing VSIX in `outputs/`.

- [x] **Step 1: Write the failing privacy audit test**

Seed a temporary fake token, absolute map path, `CustomUIData.lua`, `.log`, and official `extension.js`; assert the audit reports each category. Run the same audit on the repository and require zero findings outside the detector's own test strings.

- [x] **Step 2: Write complete user documentation**

README must cover install, uninstall, quick start, wizard, the exact project-local CLI invocation `& ".\.yuanmeng-inspector\bin\ymai.cmd"`, Codex discovery through `cli-launcher.json`, no-PATH/no-global-install behavior, stale launcher errors, Node >=20 CLI requirement, VSCode embedded-Node distinction, stale/offline meanings, two registry fields, null-fingerprint property restrictions, data directory, privacy, limitations, confirmations, build warning, troubleshooting, evidence labels, public-source/no-open-license terms, author 不见星光, and migration from the development ID `yuanmeng-local.yuanmeng-ai-dev-assistant` to `bujianxingguang.yuanmeng-ai-dev-assistant`. CHANGELOG records 0.1.0. NOTICE states public source visibility plus reserved copyright/no redistribution grant. THIRD_PARTY_NOTICES lists exact packaged dependency versions/licenses/sources from the lockfile.

- [x] **Step 3: Build and inspect VSIX**

Run:

```powershell
npm run verify
npm run package:vsix
node scripts/inspect-vsix.mjs outputs/yuanmeng-ai-dev-assistant-0.1.0.vsix
```

Expected: all automated suites pass; the VSIX contains bundled product output, manifest, icon, README, CHANGELOG, NOTICE and third-party notices; it contains no source maps, `node_modules` tree, tests, logs, `.yuanmeng-inspector`, official files, tokens, or map data.

Execution note (2026-08-20): privacy RED/GREEN passed; `npm run package:vsix` produced a 19-file VSIX and `inspect-vsix.mjs --json` returned zero findings. `out/extension-tests.cjs` was explicitly excluded. Clean Profile installation and runtime activation remain Task 18 Step 4 evidence.

- [x] **Step 4: Install in a clean Profile**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/clean-profile-acceptance.ps1 `
  -VsCodeExe .vscode-test/vscode-win32-x64-archive-1.134.0/Code.exe `
  -VsixPath outputs/yuanmeng-ai-dev-assistant-0.1.0.vsix `
  -ProfileRoot "work/acceptance/clean profile 中文"
```

The acceptance script calls the single fixture builder `build-upgrade-fixture.mjs` to create a test-only `0.1.1-upgrade-fixture` VSIX under `work/acceptance`; it uses the reviewed 0.1.0 VSIX and changes the extension and VSIX manifest versions only. It is never copied to `outputs/`, never committed, and is deleted with the disposable Profile after success. The script installs 0.1.0 into a clean extensions directory whose path contains spaces and Chinese characters, initializes the launcher, installs the test-only upgrade, reloads, and verifies version/path/hash fields and both launcher files changed atomically. It then repeats from a second extension-directory path to exercise relocation.

Expected: install, activation, project-local CLI smoke, path-with-spaces/Chinese, real test-fixture upgrade, extension-directory relocation, disable, re-enable, and uninstall all pass in repository-local `work/acceptance`; official-extension absence yields a guided offline state. After uninstall, the retained test launcher prints the specified path-invalid message, exits 2, and does not execute a replacement file with a different hash. The test confirms user/system PATH is byte-for-byte unchanged and removes the test-only upgrade artifact.

Execution note (2026-08-20): PASS on the repository-local VSCode 1.134.0 binary. The disposable Profile disabled Workspace Trust only for its synthetic workspace, suppressed welcome/update/telemetry UI, launched minimized, and closed every Profile-bound process after each case. Direct Extension Host activation log hashes, guided `OFFLINE/OFFICIAL_COMMANDS_MISSING` CLI output, 0.1.0→0.1.1 upgrade, extension-directory relocation, disabled-session non-generation, normal-session launcher/session regeneration, uninstall catalog invalidation, explicit stale-launcher failure, and unchanged PATH all passed. The user's installed VSCode 1.133.0 was separately observed refusing startup because its own update lock was active; it is not claimed as the passing binary. This remains Clean Profile evidence, not official editor linkage.

- [x] **Step 5: Verify coexistence in the user's normal VSCode only after explicit execution approval**

Install the VSIX alongside the already installed official extension, reload VSCode, confirm both extension IDs are enabled, and run the companion capability check. Do not remove, update, or modify the official extension.

Execution note (2026-08-20): normal VSCode lists both `dreamhelper.dream-helper` and the development build `yuanmeng-local.yuanmeng-ai-dev-assistant`; the disposable test project reached `online`/`fresh` after a real official file delta and companion refresh. At 17:12, with the same UI, linkage, project and VSCode window unchanged, a second real command rewrote file mtimes without changing content hashes. The companion returned `REFRESH_SUCCEEDED_UNCHANGED/unknown`, retained the 16:50 snapshot ID/time and did not create a fourth snapshot. `fresh` only meant the retained snapshot was still inside its age window. The official extension was not modified. Clean Profile lifecycle is recorded separately in Step 4. Public release changes the companion identity to `bujianxingguang.yuanmeng-ai-dev-assistant`; clean-profile and coexistence tests must be rerun under that final ID.

- [x] **Step 6: Commit**

```powershell
git add README.md CHANGELOG.md NOTICE.md THIRD_PARTY_NOTICES.md scripts package.json package-lock.json .vscodeignore test/integration/privacy-audit.test.ts
git commit -m "docs: package private VSIX release candidate"
```

Execution note (2026-08-20): completed by commit `0fcc078`; `git show --stat 0fcc078` covers the planned documentation, privacy/VSIX scripts, package metadata and privacy test files. The clean-profile GUI gates remain open as recorded above.

Do not commit the generated VSIX or `work/` contents.

## Task 19: Privacy-Safe Official Editor Acceptance and Public GitHub/Marketplace Delivery

**Milestone:** M6

**Files:**
- Create: `docs/acceptance/2026-08-19-automated.md`
- Create: `docs/acceptance/2026-08-19-official-editor.md`
- Create: `docs/acceptance/2026-08-19-release.md`
- Create: `scripts/public-release-preflight.mjs`
- Create: `scripts/export-public-repository.mjs`
- Create: `test/integration/public-release.test.ts`
- Modify: `CHANGELOG.md` only if acceptance finds and fixes a product defect
- Modify: `README.md`
- Modify: `NOTICE.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/clean-profile-acceptance.ps1`

**Interfaces:**
- Produces: immutable evidence record for automated, official-editor, multiplayer, VSIX, privacy, public GitHub, and Visual Studio Marketplace gates.

- [x] **Step 1: Re-run completion verification from a clean checkout state**

Run:

```powershell
git status --short
npm ci
npm run verify
npm run package:vsix
node scripts/inspect-vsix.mjs outputs/yuanmeng-ai-dev-assistant-0.1.0.vsix
```

Expected: only the intentionally untracked VSIX under `outputs/` appears; every command exits 0. Record command, timestamp, version and result in the automated acceptance file.

Execution note (2026-08-20): with a clean tracked worktree, `npm ci --registry=https://registry.npmjs.org --no-audit --no-fund` installed 457 packages and restored `.bin/tsc.cmd`; the explicit registry bypassed a local mirror that had produced an incomplete launcher set. On that fresh dependency tree, `npm run verify`, `npm run package:vsix`, and VSIX inspection all exited 0. After the no-change status and Clean Profile corrections, the then-current VSIX contained 22 reviewed files (about 226.8 KB) with zero inspection findings. npm emitted dependency deprecation/allow-scripts warnings, and the stable Extension Host retained separately documented host/account noise; neither is reported as clean host output. This clean dependency gate did not itself prove the Clean Profile lifecycle; Task 18 Step 4 later closed that separate gate. Property, runtime, and multiplayer gates remain open.

- [x] **Step 2: Create a new privacy-safe editor test project outside every existing map project**

The user creates or designates a disposable test map with fictional controls and one fictional test component. Record only generic labels and evidence outcome; do not copy its real IDs, coordinates, signals, raw export files, screenshots containing private content, or logs into the product repository.

Execution note (2026-08-20): the user designated the disposable UI test project; real UI schema calibration, one changed refresh plus unique search, and a corrected repeated no-change refresh completed without committing raw data. The 17:12 no-op retained the existing 16:50 snapshot and kept the snapshot file count at three; it did not manufacture a duplicate snapshot. The planned non-empty five-category diff sequence, property and other acceptance steps remain open.

- [ ] **Step 3: Execute the official editor UI acceptance sequence**

With official and companion extensions enabled: start official linkage; activate the disposable project; name one control “经验”; refresh; verify ID/type/path; add a second “经验” and verify ambiguity; then exercise add/delete/rename/move/ID-change snapshots. Record each item as pass/fail/unverified with `OFFICIAL_EDITOR_SINGLE`.

- [ ] **Step 4: Execute offline and property acceptance**

Disconnect or disable the official capability and confirm stale/offline behavior. Reconnect, read the disposable component property, change an allowed literal, preview, confirm file write, confirm push, and have the user inspect the editor value. A command return without editor observation remains `push-requested` and unverified.

Run both identity branches when the environment permits. With non-null mapFingerprint, verify exact fingerprint matching and reject another fingerprint. With null mapFingerprint, use one user-entered layer and one user-entered instance from the same project, set their environments to test/unspecified and validity to pending/confirmed, and verify the exact warning `地图身份未由官方确认` remains visible through read/edit/push. Then verify formal, invalid, suspected-change, cross-project, non-user-entry, and multi-target selections are rejected and no record is promoted to formal.

- [ ] **Step 5: Execute coexistence and build acceptance**

Run the official script generation through the companion confirmation. Confirm the artifact updated and the official extension's own command/debug entry remains usable. This proves coexistence and artifact change, not game runtime.

From the disposable project root, run `& ".\.yuanmeng-inspector\bin\ymai.cmd" status --json`, confirm the wizard copies the same command, and record Node/launcher identity. Repeat after a VSIX upgrade or changed extension install path and confirm atomic refresh. In an isolated clean-profile copy, remove the extension target and verify the retained launcher exits 2 with the defined uninstall/path-invalid message and does not execute a hash-mismatched replacement. Confirm PATH did not change.

- [ ] **Step 6: Record multiplayer honestly**

If no two-player room is run, write exactly `OFFICIAL_EDITOR_MULTI: 未验证`. If it is run, record player count, operation order and observed scope without map-private values. Do not infer multiplayer success from generated code or logs.

- [x] **Step 7: Run final privacy and Git history scan**

Run:

```powershell
node scripts/privacy-audit.mjs --repository . --history
git status --short
git log --oneline --decorate -20
```

Expected: zero secret/private/official-binary findings; acceptance docs are the only intended uncommitted text files.

Execution note (2026-08-20): the first invocation exposed that the old audit accepted but ignored `--repository` and `--history`, so it was not counted as evidence. A RED integration test now commits then deletes a synthetic token in a temporary repository; the implementation scans all reachable Git blobs and the test turns GREEN. The real command `node scripts/privacy-audit.mjs --repository . --history --json` returned `findings: []`; status/log review remained separate, and ignored calibration/output directories were not added to Git.

- [x] **Step 8: Write and verify the public release contract with TDD**

First add `test/integration/public-release.test.ts`. It runs `scripts/public-release-preflight.mjs` against temporary manifests and asserts: exact string author `不见星光`; an exact Marketplace description whose first phrase directly names the author; exact publisher `bujianxingguang`; extension ID `bujianxingguang.yuanmeng-ai-dev-assistant`; `license=UNLICENSED`; npm `private=true`; Chinese/English keywords; no `yuanmeng-local` production identity; public GitHub visibility required when remote verification is enabled; mismatched existing `origin` rejected; missing/invalid VSIX and privacy findings rejected; no token value appears in stdout/stderr. The production change that makes this test fail is accepting a local/private/mismatched release target or leaking credentials.

Run RED:

```powershell
npm run test:integration -- test/integration/public-release.test.ts
```

Expected: failure because the preflight script and public manifest contract do not exist.

Then implement `scripts/public-release-preflight.mjs`, update the manifest/lockfile/docs/clean-profile extension ID, and run the same test GREEN. The preflight performs only validation; it cannot create repositories, modify remotes, publish packages, or read a PAT from command-line arguments. `VSCE_PAT`, an Entra credential, or any other publishing token is accepted only by the later official publishing process and is never printed or persisted.

Execution note (2026-08-20): the public release suite first failed because the preflight/final identity, safe public-export helper, final Marketplace evidence gate and professional package assets were absent. Ten cases now pass after exact author/first-screen description/planned publisher/license/search/icon metadata, final Publisher/GitHub/VSIX requirements, origin/visibility rejection, credential-argument rejection, one-commit export, fixtures privacy enforcement and dirty/out-of-scope refusal were implemented. `npm run verify` passed with 145 unit and 67 integration tests. The 18-file, about 221 KB candidate VSIX includes the author-first description, 256px PNG, Activity Bar SVG, LICENSE/NOTICE/NLS/schemas/bundles and excludes `.gitignore` plus `docs/**`. `yaml@2.9.0`, pre-parse size/depth limits and an official-registry production audit with zero vulnerabilities close the production YAML advisory. The previously completed final-ID clean Profile remains installation evidence, while Marketplace rendering, Publisher creation, real GitHub URLs, property push and official build remain unverified; the large-UI RSS gate also remains unverified because prior runs exceeded the threshold.

Final regression note (2026-08-20): the public-export test now has an explicit 30-second Vitest budget and the CLI full-table test an explicit 60-second budget; measured complete-parallel times were about 4.6 and 14.6 seconds. `npm run test:integration` remains scoped to `test/integration` and did not discover any ignored public-export worktree. The complete `npm run verify` passed, official-registry production audit remained zero, and `package:release` produced the reviewed VSIX SHA-256 `19EB2CAD878A4AA287AFD51D509B6D633BA40B88A2735F329ABFAC68E1F487E1`. The missing-repository warning remains a deliberate external GitHub gate, not a release PASS.

- [x] **Step 9: Commit public release metadata and acceptance evidence**

```powershell
git add package.json package-lock.json README.md CHANGELOG.md NOTICE.md schemas src/core/launcher/manifest.ts scripts/public-release-preflight.mjs scripts/export-public-repository.mjs scripts/verify-data-contracts.mjs scripts/clean-profile-acceptance.ps1 test/unit/launcher-manifest.test.ts test/integration/public-release.test.ts test/integration/cli-m1.test.ts test/extension docs/superpowers docs/acceptance docs/evidence
git commit -m "feat: prepare public marketplace release"
```

Execution note (2026-08-20): commit `52a1f27` records the public identity, author-first metadata, no-op editor evidence and release preflight foundation. The subsequent corrective increment adds the not-yet-confirmed Publisher gate, real-URL final-release gate, PNG icon, LICENSE, third-party disclaimer, experimental editor-command labels, minimal VSIX, fixtures privacy enforcement and `yaml@2.9.0` import hardening. The 18-file candidate reran the complete Clean Profile lifecycle successfully; this still does not satisfy Publisher creation, GitHub URL, real property push or official build evidence.

- [x] **Step 10: Build and audit a clean public-source repository, then verify GitHub authorization**

The local development history is retained locally and is **not** pushed to the public repository. Before any GitHub operation, create an ignored disposable repository under `work/public-release-repository`, copy only the current Git-tracked files from the reviewed commit (excluding `.git`, ignored work/output data and generated VSIX files), initialize a new `main` branch, and make one public-source commit. This avoids exposing obsolete development-only evidence strings while preserving the local repository intact. Run privacy audit against both its working tree and its new single-commit history:

```powershell
git status --short
$publicRoot = Join-Path (Resolve-Path work) 'public-release-repository'
# Create the directory only through the reviewed export helper; never copy the local .git directory.
node scripts/export-public-repository.mjs --source . --destination $publicRoot
node scripts/privacy-audit.mjs --repository $publicRoot --history
git -C $publicRoot status --short
git -C $publicRoot log --oneline --decorate --all
```

Expected: local reviewed commit is clean; the export contains only tracked current-source files, has exactly one root commit on `main`, and both its tree and history have zero privacy findings. The helper must refuse a destination outside `work`, a non-empty destination, a dirty source worktree, any tracked raw editor export/log/binary/secret, or any attempt to include the source `.git` directory.

Execution note (2026-08-20): after corrective commit `6956001`, the helper produced `PUBLIC_EXPORT_READY` with 146 tracked files and one root commit `0bd5cd8`; after documentation commit `fab2c3d`, the final local target `work/public-release-repository-final` produced one root commit `02e5113`. After URL metadata commit `57f015e`, `work/public-release-repository-57f015e` produced one root commit `85dc9f6`; tree/history privacy audit and non-final preflight returned zero findings. The target was verified as PUBLIC for `yzy-gm`, and the snapshot was pushed only after its empty origin was checked. The local development repository remained without a remote.

Only after the clean export is verified, check authorization and query the target:

Run:

```powershell
gh auth status
$login = gh api user --jq .login
gh repo view "$login/yuanmeng-ai-dev-assistant" --json nameWithOwner,visibility,url,sshUrl
$expectedBeforeCreate = @("git@github.com:$login/yuanmeng-ai-dev-assistant.git", "https://github.com/$login/yuanmeng-ai-dev-assistant.git")
$origin = git -C $publicRoot remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0 -and $expectedBeforeCreate -notcontains $origin) { throw "origin mismatch; repository creation and push stopped: $origin" }
```

Expected: authenticated account is known. If the repository exists, access is available and visibility is `PUBLIC`. If it does not exist, the repository query may report not found; that is the only case where creation proceeds. An absent origin in the clean export is allowed; an existing origin must already identify the intended account/repository or the workflow stops before creating or pushing anything. The local development repository's remotes are not modified.

- [x] **Step 11: Create or push the public repository**

If the public repository is absent, create it without adding or pushing a remote:

```powershell
$login = gh api user --jq .login
gh api --method POST user/repos -f name='yuanmeng-ai-dev-assistant' -F private=false
```

Then query the authoritative public target and validate origin before pushing:

```powershell
$login = gh api user --jq .login
$repoInfo = gh repo view "$login/yuanmeng-ai-dev-assistant" --json nameWithOwner,visibility,url,sshUrl | ConvertFrom-Json
if ($repoInfo.visibility -ne 'PUBLIC') { throw 'GitHub target is not public; push stopped' }
$allowedOrigins = @($repoInfo.sshUrl, "$($repoInfo.url).git")
$origin = git -C $publicRoot remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) {
  if ($allowedOrigins -notcontains $origin) { throw "origin mismatch; push stopped: $origin" }
} else {
  git -C $publicRoot remote add origin $repoInfo.sshUrl
}
git -C $publicRoot push -u origin main
```

The clone URL is obtained from `gh repo view`; it is never guessed. An existing origin is never overwritten or blindly re-added. Any origin not exactly equal to the target SSH URL or target HTTPS URL plus `.git` stops the workflow and is reported to the user. Expected: only the clean single-commit public export is pushed after identity and public visibility are confirmed; the local development history and its remotes remain private and unchanged.

Execution note (2026-08-20): GitHub target `yzy-gm/yuanmeng-ai-dev-assistant` was verified `PUBLIC`; the clean snapshot `85dc9f6` was pushed to `main` after confirming it had no pre-existing remote. No remote was added to the local development repository.

- [x] **Step 12: Verify remote contents and release state**

Run:

```powershell
git -C $publicRoot status --short
git -C $publicRoot ls-remote --heads origin main
gh repo view yuanmeng-ai-dev-assistant --json name,visibility,url
```

Expected: the clean export is clean; remote `main` points at its single public-source commit; visibility is `PUBLIC`; a fresh clone passes the repository privacy audit and public release preflight. If authentication, permissions or push fails, record the exact blocker and state “GitHub 未上传”.

Execution note (2026-08-20): `git ls-remote` returned `85dc9f620dbd28674b24d48edd352385565264ae`; a fresh clone matched that commit and passed working-tree/history privacy audit plus non-final public preflight.

- [ ] **Step 13: Create/verify the Marketplace Publisher and publish the reviewed VSIX**

The planned publisher ID candidate is `bujianxingguang` and the display name is `不见星光`. It is not registered, reserved, stable, or final until the user signs in to the official Marketplace management page and successfully creates it. Because Publisher IDs are immutable, an unavailable ID stops publication before changing to any fallback. Do not treat the old local ID or the candidate VSIX `GalleryFlags=Public` as a Marketplace account or live listing.

After the final public GitHub URL is known, add `repository`, `homepage`, and `bugs` URLs using that authoritative URL, rerun the public preflight, full verification, privacy/history audit, VSIX packaging and inspection, and commit the final URL metadata. Publish exactly the inspected VSIX through the official Marketplace management page or `vsce publish --packagePath <reviewed-vsix>` using an official scoped credential/Entra identity that is not passed as a command argument or stored in the repository. Never echo credential values.

- [ ] **Step 14: Verify Marketplace discovery and installation**

Query the public item identity `bujianxingguang.yuanmeng-ai-dev-assistant`, confirm version 0.1.0, author/display metadata and public availability, then use a disposable clean VSCode Profile to search by “元梦 AI 开发助手”, “元梦”, “Yuanmeng” and the exact extension ID. Install from Marketplace, activate the anonymous fixture workspace, verify guided official-extension-missing status and the project launcher, then uninstall and close the Profile. Marketplace PASS does not imply official editor, property, build, runtime or multiplayer PASS.

## Final Verification Matrix

Before claiming the implementation complete, all automated rows must pass and every manual row must be explicitly pass/fail/unverified:

| Gate | Command or evidence | Required release state |
|---|---|---|
| Type/lint/unit/integration | `npm run verify` | PASS |
| CLI JSON/exit codes | `test/integration/cli-full.test.ts` | PASS |
| Project-local CLI launcher | Extension Host + clean-profile launcher tests | PASS |
| VSCode 1.70.x host | `run-extension-tests --version 1.70.3` | PASS |
| VSCode 1.70 runtime capabilities | recorded embedded Node + core smoke test | PASS |
| Current stable host | `run-extension-tests --version stable` | PASS |
| 100k UI performance | `test/integration/large-ui.test.ts` | PASS |
| VSIX content/privacy | `inspect-vsix.mjs` and `privacy-audit.mjs` | PASS |
| Clean Profile install/uninstall | `clean-profile-acceptance.ps1` | PASS |
| Official UI refresh/search/diff | acceptance record | PASS, FAIL, or UNVERIFIED; never inferred |
| Official property application | user/editor observation | PASS, FAIL, or UNVERIFIED |
| Official build coexistence | editor observation + artifact hash | PASS, FAIL, or UNVERIFIED |
| Multiplayer | two-player observation | PASS, FAIL, or UNVERIFIED |
| GitHub public push | `gh repo view` + `git ls-remote` | PASS for repository delivery |
| Marketplace publisher | official publisher management identity | PASS before publishing |
| Marketplace discovery/install | public item query + clean Profile install | PASS for extension delivery |

## Execution Handoff

After the user approves this specification and plan, execute tasks in order with the TDD and commit gates above. Use one modification owner for the repository. A separate reviewer, if the user explicitly authorizes one, remains read-only and re-reads current files before reporting. Stop and report rather than bypass any confirmation, privacy, editor, authentication, or permission gate.
