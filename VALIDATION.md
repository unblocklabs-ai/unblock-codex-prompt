# Validation

## Claude CLI prompt through `before_prompt_build`, no core patch — 2026-11-02 (unreleased, 0.5.0)

- **Owner decision.** Claude is treated like Codex: for the target agent's `claude-cli`
  runs, subagent sessions included, OpenClaw's system prompt is replaced completely.
  `extraSystemPrompt` content (incognito, group prompts, subagent task framing) and
  per-person `USER.md` overlays are dropped; the README lists everything else dropped.
- **Hook.** `before_prompt_build` returns `{ systemPrompt }` when `ctx.modelProviderId`
  is `claude-cli` (case-insensitive, as OpenClaw's `isClaudeCliBackendId`), `ctx.agentId`
  is the configured target (the managed-target predicate's semantics, now also a runtime
  function), and the enrollment is active and includes Claude CLI. The prompt is the
  Claude policy, the memory reference, then each present, non-empty `AGENTS.md`,
  `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` from
  `ctx.workspaceDir` (else the configured workspace) under `## <absolute path>`, read
  every call. Per-file cap: agent `bootstrapMaxChars`, else
  `agents.defaults.bootstrapMaxChars`, else 20000; `USER.md` at most 4000 (OpenClaw's
  `DEFAULT_BOOTSTRAP_MAX_CHARS`/`USER_BOOTSTRAP_MAX_CHARS`, `bootstrap-*.mjs`, identical
  in 2026.10.6 and 2026.10.9). Invalid or tampered state (enrollment, bundle,
  prompt-file hash, Claude policy) logs an error without prompt text and returns nothing.
- **Verified OpenClaw behavior (2026.10.6 and 2026.10.9).** `prepareCliTurnPromptContext`
  replaces the built prompt with a trimmed hook `systemPrompt`, after the backend's
  `transformSystemPrompt`; only text transforms and the model identity line follow.
  `mergeBeforePromptBuild` keeps the first `systemPrompt` (highest priority first).
  Side questions and control operations skip prompt-build hooks.
- **Permission.** `before_prompt_build` is both a prompt-injection hook
  (`hook-types-*.mjs`: `isPromptInjectionHookName`) and a conversation hook
  (`registry-*.mjs`: `conversationHookNames`). `registerTypedHook` refuses it when
  `allowPromptInjection === false`, and for a non-bundled plugin unless
  `allowConversationAccess === true` (`hook-policy-decisions-*.mjs`). OpenClaw's
  `docs/plugins/hooks.md` says the same ("The first two hooks therefore need both
  permissions"). So the conversation-access grant is still required; sync refuses Claude
  without it or with prompt injection disabled, and the hook is registered only then.
- **Removed.** The Claude assembly patch (fingerprints, render/helper edits, prepare and
  install), the `before_agent_run` final-adoption gate and its runId correlation,
  `checkClaudeAdoption`, `readClaudeManagedPrompt` (replaced by
  `readClaudeManagedContext`, so a leftover 0.4 patch finds no export and renders
  upstream), `scripts/validate-claude-layout.mjs`, `test/fixtures/claude-assembly.json`
  and the patch-only tests.
- **0.4 cleanup.** The receipt parser and `planClaudeRestore`/`applyClaudeRestore` stay on
  the shared patched-file lifecycle. Sync validates a leftover patch (files and backups)
  before fetching or writing, restores it after the prompt state, and reports
  `legacyClaudeCoreRestored` with `restartRequired: true`. Restore still removes it.
  Status reports `legacyClaudeCore` (`leftover`, `state`, `coreIntegrity`); a leftover
  makes Claude not ready and is logged at startup. A Codex-only sync no longer refuses
  over a leftover Claude patch; it removes it.
- **Status and activation.** `claude.ready` = enrolled, valid Claude policy, hook grant,
  no leftover patch; `claude.promptHook` is `granted` or the reason. Sync activation for
  Claude: no restart once the Gateway runs this version; a restart only to load a plugin
  install/update or after a 0.4 core patch was removed. Claude-only sync no longer needs
  the packaged runtime entry (only Codex patches load it).
- **Real-OpenClaw check.** `scripts/validate-claude-hook.mjs` (also in `npm test` via
  `test/claude-hook-openclaw.test.mjs`) passed against 2026.10.9 (dev dependency) and the
  2026.10.6 install. It registers this plugin through OpenClaw's own typed-hook
  registrar, runs the real hook runner, `resolvePromptBuildHookResult` and
  `prepareCliTurnPromptContext` (and `finalizeCliSystemPrompt` on 2026.10.9), and asserts
  the CLI runner's wiring on source. It does not run a Claude CLI process.
- **Tests.** Hook output order and exact text, MEMORY.md and missing/empty files, live
  edits, unmanaged agent/provider/paused/disabled/Codex-only, tampered state logging,
  caps, workspace fallback and symlink boundary, registration grant; legacy restore
  scenarios (clean, partial, update, foreign edit, invalid backup); sync removal with
  byte check, refusal before fetch on a foreign edit, status and restore reporting;
  sync refusal without conversation access or with `allowPromptInjection: false`.

## Live OpenClaw skills catalog on Codex — 2026-11-01 (unreleased, 0.4.0)

- **Codex gets the session catalog live.** The reviewed `renderCodexSkillsInstructions`
  is renamed and wrapped (as the thread and workspace wrappers are) instead of returning
  early. Unmanaged: the original output. Managed: the original renderer runs, its output
  (OpenClaw's "## OpenClaw Skills" section with the `skills_search`/`skills_read` hints
  and the raw session snapshot prompt, or nothing when
  `shouldIncludeAgentHarnessRuntimeContext` fails) is relayed on the attempt params, and
  the wrapper returns nothing, so skills are in neither the refreshable nor the
  parent-local carrier. Checked against real 2026.10.5 and 2026.10.9: the only call site
  passes `runtimeParams` (fresh per attempt) after the workspace loader and before
  `buildDeveloperInstructions(runtimeParams)`; all four functions were already pinned
  and are byte-identical. No fingerprints were added.
- **One live-context relay.** `Symbol.for("unblock-codex-prompt.live-context")` holds
  `{ skills, persona }`, non-enumerable (copies of params and request fingerprints do not
  carry it). It replaces the `unblock-codex-prompt.persona` key. Managed developer
  instructions are `[policy, skills, persona, gitCoauthorPrompt, normalized additions]`,
  empty sections dropped. The relay is inline in the patch, so it keeps working after a
  plugin rollback without restore.
- **No frozen catalog.** `buildSkillsCatalog` (OpenClaw's private `buildSkillSnapshot`
  export) and the catalog segment are gone; the bundle no longer has `sources` or
  `skillCount` (a 0.3 runtime reads only `schema`, `policy` and `promptSha256`). Refresh
  still slices at `basePromptLength`, so an older snapshot keeps its frozen catalog tail
  byte-for-byte until the next sync; the older patch suppresses the live catalog, so no
  thread sees both. Sync output no longer reports `skillCount`.
- **One managed-target predicate.** `src/managed-target.ts` generates the inline
  JavaScript both bridges use (plugin enabled and allowed, entry enabled,
  `frozenContext: true`, target agent default `main`, target-changed error). Claude passes
  its `claude-cli/` model-display check as an extra condition, evaluated before the
  target-changed error as before. The gate's `targetAgent` in `src/index.ts` is unchanged.
- **Behavior notes (README).** Between sync and the Gateway restart the earlier patch
  still suppresses skills while the new file has no catalog: drain and restart. A catalog
  change, like a persona edit, makes Codex refuse a live incognito thread's next turn.
  Editing only a `SKILL.md` body does not change the catalog.
- **Tests.** Refreshable adapter: exact `skills, persona, COAUTHOR, ROUTING` on creation
  and reuse with no refreshable or parent-local carrier; a changed tag shows the new
  catalog; unmanaged agents and a paused enrollment keep upstream refreshable and
  parent-local skills; no harness runtime context gives no skills; the hints pass
  through (with and without a prompt); a `{...params}` copy has no skills; renderer,
  workspace loader and developer builder in three separate VM realms; an older runtime
  without `readCodexBaseInstructions` still relays skills. Compile: no catalog in the
  Codex base file, no `sources`/`skillCount`. Refresh: 0.3 and pre-change 0.4 snapshots
  keep their catalog tail byte-for-byte. New `test/managed-target.test.mjs` compares the
  generated predicate with both previous inline gates over a config matrix. New
  `scripts/validate-claude-layout.mjs` check renders the patched real
  `buildAgentSystemPrompt` with a `nativeCommandGuidanceLines` sentinel and the managed
  params: kept, once (#11 P3-13). Claude-only daily refresh schedule test: the timer is
  armed from the enrolled runtime's `checkedAt`, not immediately.

## Per-runtime fleet policy delivery (issue #11) — 2026-11-01 (unreleased, 0.4.0)

- **Codex is unchanged.** It fetches the configured `promptUrl` with no `runtime`
  parameter, so it works against the deployed Worker; the prompt file layout, the prefix
  refresh and `policy: ""` are as before.
- **Claude** fetches `promptUrl` with `runtime=claude` (URL API, `channel` kept) and
  requires `X-Prompt-Runtime: claude`. The receipt stores `claudePolicy` (`text`, `url`,
  `revision`, `checkedAt`) and `agentContext`; `readClaudeManagedPrompt` returns
  `claudePolicy.text + "\n\n" + agentContext` from the receipt only, with the prompt file
  still checked against `promptSha256`. Removed: `catalogLength`, the frozen-catalog
  boundary check and the dead `policy.trim()` join (P3-12).
- **Claude-only prompt file** holds just the agent context (the
  `## Memory reference` section). Claude-only sync never fetches the Codex artifact; no
  `remotePrompt`/`basePromptLength`.
- **Sync and refresh** fetch every enrolled runtime before writing. Any failure writes
  nothing; HTTP 400 for `runtime=claude` (a Worker without runtime support) and a missing
  `X-Prompt-Runtime` say to deploy the fleet-prompt Worker with runtime support first.
  Refresh then updates the Codex prefix and/or `claudePolicy` in the existing locked
  write (prompt rollback if the receipt write fails) and returns `nextCodexTurn` and
  `nextClaudeProcess` separately, plus `revision` (Codex) and `claudeRevision`.
- **Status and sync output** report `remotePrompt` (Codex) and `claudePolicy` (`url`,
  `revision`, `checkedAt`); policy text is never printed. The daily schedule uses the
  oldest `checkedAt` among enrolled runtimes.
- **Trust root:** the receipt. Editing `claudePolicy` changes the managed prompt, and the
  gate compares against the receipt as it is then: an edit after assembly blocks, an edit
  before assembly is indistinguishable from a sync. A missing or malformed `claudePolicy`
  or `agentContext` throws "run codex-prompt sync" and the gate blocks.
- **Intentional test changes:** `refreshSharedPrompt` takes `{ codex?, claude? }` fetchers
  (remote tests); `compilePrompt(base, workspace, claudePolicy?)` accepts a null
  base for Claude-only (Claude fixtures in the lifecycle, adapter and ownership
  tests now pass a Claude policy; the Claude-only fixtures use the agent-context-only file;
  the mixed fixture adds Codex with the Codex layout).
- **New tests** (`test/runtime-policy.test.mjs`): Codex-only sync/refresh against a Worker
  that rejects `runtime`; Claude-only sync without the Codex artifact; both
  runtimes make exactly two fetches; a changed Claude revision leaves the Codex file
  byte-, inode- and mtime-identical; a changed Codex revision leaves the Claude prompt
  identical; failed Claude fetches (400, unconfirmed runtime, offline, 503) write nothing
  and name the Worker deploy; invalid Claude policy fails closed; tampered `claudePolicy`
  against the gate; status reports revisions without text.
- `npm run preflight` (Node 24.22.1): 75 tests, both Inspector checks, package
  validation. `scripts/validate-claude-layout.mjs` (distinct Codex and Claude policies;
  Claude renders only its own, once; six gate passes) passes on OpenClaw 2026.10.6 and
  2026.10.9. Real `@openclaw/codex` 2026.10.5 and 2026.10.9 patch 6 files; 2026.9.9 is
  refused. No patch fingerprints, Codex persona mechanism, gate logic or
  `src/patched-files.ts` changed.

## Shared patched-file lifecycle (issue #11) — 2026-11-01 (unreleased, 0.4.0)

- **One lifecycle for both adapters.** `src/patched-files.ts` owns receipt ownership,
  prepare, install, status and restore planning. The adapters keep discovery,
  fingerprints, patch rendering, receipt formats and install identity. Receipt paths and
  formats are unchanged; 0.2.0 schema-1 and 0.3 version-less Codex receipts still read
  and restore. Ownership: `patched` if any file holds our bytes; `restored` if all are
  original; `superseded` if every changed file is missing or the recorded version was
  replaced; otherwise `changed`. A restored or superseded receipt is cleared: any root,
  replaceable backups.
- **Restore** plans both adapters (nothing unless our bytes are installed), refuses
  only if there is no enrollment and nothing to restore, validates the pointer and
  pauses, then restores the Codex catalog and skills block (Codex enrollments only),
  then applies both plans. Behavior change: an adapter whose files no longer hold our
  bytes (`changed`, for example a single-file 0.2.0 receipt with a foreign edit) is
  reported, not refused. Codex adapter status gains `state`, `packageDir` and
  `packageVersion`.
- **Enrollment:** schema 1 unless active Claude-only (schema 2); Codex-only omits
  `runtimes`. An active Codex and Claude enrollment is schema 1, which 0.3.x reads as Codex.
- **Detection** counts only the agent's own allowed-model map.
- **Startup log:** without the grant it reports that the gate is not registered and runs
  are not checked.
- **Removed:** `promptMatches`/`expectedSha256`, refresh's branch for snapshots without
  `basePromptLength` (every remote snapshot since 0.1.0 records it; the older
  `## Agent context` and `## Frozen agent context` boundary headings are still accepted), and `restoreAdapter`/`restoreClaudeAdapter`.
- Tests: a table-driven suite runs seven ownership/restore scenarios against both
  adapters with identical outcomes. Further tests cover a version-less 0.3 receipt after
  an update renames its bundles, a deleted OpenClaw root, a refused restore leaving the
  skills block and catalog unchanged, a changed Claude receipt not blocking a Codex-only
  restore, the enrollment schemas against a 0.3 parser, and the startup log.
- `npm run preflight` (Node 24.22.1): 66 tests, both Inspector checks, package
  validation. `scripts/validate-claude-layout.mjs` passes on OpenClaw 2026.10.6 and
  2026.10.9. Real `@openclaw/codex` 2026.10.5 and 2026.10.9 patch 6 files, pass
  `node --check`, record their version and restore exact bytes; 2026.9.9 is refused.

## Review findings (issue #10) — 2026-11-01 (unreleased, 0.4.0)

- **#1** Restore restores the Codex adapter only while Codex is actively enrolled or
  this adapter's bytes are still installed. New Codex receipts record `packageVersion`;
  files replaced after a version change are superseded, and other changes are still
  refused. Test: Codex restore, package update, Claude enroll, restore succeeds, Codex
  re-sync against the updated package. Test: a same-version edit is refused.
- **#2** Not changed in code; the README gives the manual recovery.
- **#3** The Codex and Claude patches feature-detect `readCodexBaseInstructions` and
  `readClaudeManagedPrompt`, falling back to unmanaged behavior on an older runtime
  (tests for both). A restored enrollment is saved as schema 1 with a `runtimes` field
  0.3.x ignores (0.3.x `parseEnrollment` checks only `schema`, `active` and
  `previousPointer`); an active Claude enrollment stays schema 2. README has the rollback
  procedure.
- **#4** Detection follows OpenClaw's `resolveAgentEffectiveModelPrimary` and
  `resolveSelectedModelFallbacksOverride`; allowed-model maps still count.
- **#5** The startup "not ready" error requires active enrollment (test: no error after
  restore).
- **#6** Restore validates adapter files, backups and the pointer, then pauses
  enrollment, then restores adapters. Test: a foreign edit or foreign pointer leaves
  enrollment, Codex and Claude unchanged.
- **#7** The managed Claude branch keeps `nativeCommandGuidanceLines`.
- **#8** The unreachable `promptMode`/`sandboxInfo` check is removed.
- **#9** `scripts/validate-claude-layout.mjs` asserts `checkClaudeAdoption` passes for
  six real renders. It passes on OpenClaw 2026.10.6 and 2026.10.9.
- **#10** Documented as a known limitation in the README.
- `npm run preflight` (Node 24.22.1): 55 tests, both Inspector checks (same two advisory
  gaps), package validation. Real `@openclaw/codex` 2026.10.5 and 2026.10.9 patch
  (thread wrapper present, receipt version recorded) and pass `node --check`; 2026.9.9 is
  refused.

## Live identity files — 2026-11-01 (unreleased, 0.4.0)

SOUL.md, IDENTITY.md, USER.md (shared and the session's selected personal file) and
AGENTS.md are no longer snapshotted; both runtimes deliver them live every turn.

- **Codex.** The reviewed workspace-context wrapper hands the host-rendered persona to
  the reviewed `buildDeveloperInstructions` patch, which places it after the fleet
  policy in the thread developer instructions (not the parent-only or refreshable
  carriers). Tests: an edit appears in the next turn's thread instructions; personal
  overlay included; memory stays suppressed (skills: see the live catalog entry above);
  the relay is non-enumerable; a fork that never assembled workspace context starts
  without persona.
- **Codex floor raised to 2026.10.5.** Checked every published `@openclaw/codex`
  release: 2026.10.5, 10.6, 10.7, 10.8 and 10.9 have byte-identical reviewed context
  and operational functions; 2026.9.9 still uses the turn-scoped layout and
  2026.10.1–10.4 differ. The real 10.5–10.9 packages patch, pass `node --check`, and
  call the workspace loader before the developer builder on the same attempt object;
  9.9, 10.1 and 10.4 are refused. Older-layout code paths and their tests were removed;
  0.2.0 single-file receipts still restore.
- **Claude CLI.** The render patch now drops only the MEMORY body; OpenClaw's project
  context carries SOUL, IDENTITY, shared and personal USER with its own wording. The
  real-layout script passes on 2026.10.6 and 2026.10.9 with live files present and
  disk copies absent.
- **Claude Code subagents** do not receive the appended system prompt (Claude Code
  2.1.316: parent saw a marker, a native subagent reported it absent), so they see
  neither fleet policy nor persona.
- Dev dependency moved to `openclaw@2026.10.9` (requires Node >=24.22; CI uses 24).
  `scripts/check-package.mjs` accepts npm 11's keyed `pack --json` output.
- `npm run preflight` on Node 24.22.1: **52 tests**, both Inspector checks (same two
  advisory gaps), package validation (35 files).

- **Live fleet policy.** The policy stays the prefix of the Codex base file (the fallback
  if the adapter is missing). The reviewed `buildCodexThreadConfiguration` is wrapped to
  send the verified file as `baseInstructions` on thread start, resume and fork. Checked
  against the real 2026.10.9 code: warm threads compare a request fingerprint that
  includes `baseInstructions` and resume on mismatch; incognito threads compare only
  developer instructions, so they keep their starting revision. Checked live with Codex
  CLI 0.166.0 app-server, and again with **0.160.0**, the app-server version pinned by
  `@openclaw/codex` 2026.10.5–10.9 (`CODEX_APP_SERVER_VERSION`). In both, a thread started
  with base A answered A, the same thread resumed with base B answered B, and a resume
  without a base fell back to the configured base. The real 10.5–10.9 packages patch and pass `node --check`.

**Not yet validated live:** a policy refresh or persona edit reaching an existing
Codex thread through the policy handoff on the next turn, a resumed Claude conversation
picking up a new revision, native Codex children seeing persona, compaction
retention, and the incognito-thread refusal after a persona edit.

## Claude CLI fleet policy (issue #9) — 2026-11-01 (unreleased, 0.4.0)

Implements the revised plan in issue #9. Baseline f72b415.

**Automated (this repository).** `npm run preflight` passed: TypeScript build,
**56 tests**, both Plugin Inspector checks (the same two advisory proof gaps, zero
live issues) and package validation (**35 files**). New coverage:

- Claude assembly adapter against the exact 2026.10.6 function bytes: patches only
  the reviewed chain, re-syncs from backups, refuses changed functions, duplicate
  definitions and foreign edits, restores exact bytes, and after a simulated
  OpenClaw update skips the updater's chunks and re-syncs against renamed ones.
- The patched `buildCliAgentSystemPrompt` manages only the target agent on
  `claude-cli/`; other agents, other CLI backends, `anthropic/` displays and
  disabled config stay upstream; a tampered snapshot aborts.
- Claude-only lifecycle: no `config.toml`, schema-2 state, refresh without a
  pointer (`nextClaudeProcess`, no Codex new-session guidance), restore. Adding Codex
  later captures and restores its pointer; Codex-only state keeps schema 1.
- Detection through a supplied `resolveModelRuntimePolicy` and legacy refs. The
  CLI refuses sync with no detected runtime or without the gate grant, before any
  fetch or write.
- Gate: runs are marked from the preparation hook context. Other runtimes,
  agents and unprepared runs pass. Unenrolled runs pass and are reported. A missing
  patch, an altered policy, a missing prompt or tampered state block; prompt text is
  never logged. No hooks are registered without the grant or with prompt injection
  disabled.
- Codex refreshable wrapper keeps only the personal overlay in `personaInstructions`.
  Shared persona and memory stay suppressed; other agents stay upstream.

**Review fixes (Codex review, each reproduced first by an independent check).**
Each regression test below fails against the pre-fix build.

- Gate fallback: a Claude attempt that fails between preparation and execution no
  longer gates a non-Claude fallback under the same run ID. Each preparation
  replaces the mark, and gate contexts naming a non-Claude provider pass, including
  attempts that skip prompt-build. Claude after a non-Claude attempt is still gated.
- Runtime removal: a receipt kept by restore no longer re-selects its runtime.
  Ownership comes from disk. Tested: enroll Claude, interrupted restore (refused with
  "finish restore"), completed restore, then Codex-only sync without the grant
  leaves core untouched; the reverse; a different Codex package or OpenClaw root
  after a clean restore; and partial, superseded and changed ownership states.
- Codex settings: unsupported `appServer` settings no longer block a first
  Claude-only enrollment, status or restore. Sync still rejects them when it selects
  Codex. Status and startup report them for a Codex enrollment. Restore still
  refuses foreign edits under unsupported settings.
- Both real layouts (2026.10.6, 2026.10.9) re-validated after these changes.

**Real OpenClaw core.** `scripts/validate-claude-layout.mjs` passed against
disposable npm installs of **openclaw 2026.10.6 and 2026.10.9** (different chunk
names, byte-identical reviewed functions). Through the real assembly: fleet policy
once; frozen SOUL/IDENTITY/shared USER; live AGENTS, TOOLS and the personal overlay;
no live SOUL, shared USER or MEMORY body; no frozen catalog; generic identity,
Execution Bias, Care, OpenClaw Control, Tool Call Style and Silent Replies absent;
Messaging, Output Directives, Authorized Senders, Runtime, unknown extra context and
incognito text retained. A live session catalog survives when no native mount
exists. Other backends/agents and restored enrollment render upstream. After
restore the patched chunks match `dist/postinstall-content-inventory.json`.

**Fleet policy.** Runtime-neutral, capability-aware wording is prepared on the
`fleet-prompt` branch `feat/runtime-neutral-policy` (sections 00, 04, 05, 06, 07,
08; dev and prod identical; `npm test` passed, 5 tests). It is not deployed.

**Not yet validated (required before advertising Claude support):** a live Gateway
on 2026.10.6+ with Claude CLI 2.1.x. That means fresh native `prompt_snapshot`
captures; real native skill invocation through the `openclaw-skills` mount;
follow-up, reuse and resume; prompt refresh; personal-context changes; compaction;
applicable delivery modes; the gate blocking after a real update; restore; and
OpenClaw update and rollback with the patch present on a disposable install. The
Codex personal-overlay change also needs a live parent-local relay check. Messaging
mechanics are kept through OpenClaw's own builder, which still includes two short
routing lines (subagent arguments, user-authorized CLI/API use).

## Remote-only follow-up — 2026-11-01 (unreleased)

This follow-up supersedes the bundled-template and dev-only state described in
the initial issue-fix validation below.

- Removed the bundled system/developer templates, their loader and identity
  substitution, and the no-URL/base-only branches. `promptUrl` and
  `frozenContext: true` are now required in both manifest and runtime validation.
  The legacy `agentName` key is accepted but ignored so existing fleet configs
  need no edits. Identity still comes from agent documents.
- Cloudflare remains the sole shared-policy source. Generated instructions stay
  in the agent's OpenClaw-managed `codex-home`, not in the plugin package. Daily
  refresh and hourly error retries remain unchanged. A failed download retains
  the already-installed agent instructions; there is no packaged fallback.
- The existing config regression failed before the change because a missing
  `promptUrl` was accepted, and passed after the remote-only requirement was added.
  The obsolete template-substitution test was removed along with its sole
  production caller; configuration coverage remains at the remote boundary.
- A real Commander CLI test now runs sync, refresh and restore against temporary
  agent directories and published adapter-function fixtures. It verifies that
  fetched text (including literal `{{identity}}`) becomes Codex's base, the
  installed adapter replaces OpenClaw's generic developer policy with empty text
  while preserving routing additions, refresh leaves frozen identity unchanged,
  outages retain the installed prompt, and restore recovers original adapter bytes.
  The HTTP response is synthetic; this is not a live fleet or model-behavior test.
- Fleet sections 02, 03 and 15 now have identical wording in **dev and prod**:
  visible progress routing, payload/output verification, and relevant connected
  lookup before asking the user. Both builds produce revision
  `ef55c1cdbf840e418fc7640e0ec6e6d2df1ce12feb590768451734c5e90fca54`.
  Each channel's changed sections grew from **579 to 619 words** in total
  (lifecycle 426 → 430, tool use 102 → 118, integrations 51 → 71).
- Final `npm run preflight` passed: TypeScript build, **40 tests**, both Plugin
  Inspector checks and package validation (**31 files**, no `prompts/` assets).
  Inspector retains its two previously documented advisory proof gaps, with zero
  live breakages. Fleet `npm test` passed all **five tests** and rebuilt both
  channels; the three changed section pairs are byte-identical. Both repositories
  pass `git diff --check`. The full uncommitted plugin change set, including the
  preceding issue fixes, is **+225/-66 source/tooling lines**, **+289/-30 test and
  fixture lines**, and **195 deleted template lines**.

Only the two explicit template files were deleted. Their last uncommitted contents
were backed up under `/tmp/unblock-prompt-remote-only.TOuVJa/`; committed versions
are also recoverable through Git. No fleet config, running service, deployed
Cloudflare channel, or installed agent prompt was changed. OpenClaw plugin,
fleet-prompt editing and test-audit skills guided compatibility, policy placement,
and the CLI-level regression boundary.

### Current review map

- Removed: `prompts/system.md`, `prompts/developer.md`.
- Remote-only selection and compilation: `src/config.ts`, `src/index.ts`,
  `src/compiler.ts`, `src/remote.ts`.
- Packaging/config/docs: `package.json`, `openclaw.plugin.json`,
  `scripts/check-package.mjs`, `README.md`, `RELEASING.md`, `VALIDATION.md`.
- Native/OpenClaw instruction cleanup: `src/catalog.ts`, `src/context.ts`,
  `src/adapter.ts`, `src/runtime.ts`, `src/manager.ts`.
- Refresh error reporting: `src/refresh-error.ts` and `src/index.ts`.
- Tests: `test/prompt.test.mjs`, `test/remote.test.mjs`, `test/plugin.test.mjs`,
  `test/bridge.test.mjs`, `test/catalog.test.mjs`,
  `test/refreshable-adapter.test.mjs`, `test/fixtures/adapter-operational.json`,
  `test/fixtures/openclaw-additions.json`.
- Neighboring `fleet-prompt`: `02-task-lifecycle-and-progress.md`,
  `03-tool-discovery-and-use.md`, `15-apps-mcp-and-integrations.md` under **both**
  `prompts/dev/sections/` and `prompts/prod/sections/`.

## Initial issues #3–#8 local validation — 2026-11-01 (before remote-only follow-up)

- The catalog, refresh-diagnostics and operational-request regressions were run
  against an isolated copy of the original `HEAD`. All three failed for their
  intended reasons: native prose was unchanged, refresh logged only a generic
  warning, and active-computer context survived request assembly.
- Plugin preflight passed: TypeScript build, 40 tests, static/runtime Plugin
  Inspector and package validation (33 files). Inspector still reports the same
  two advisory evidence gaps for isolated dependency installation and service
  capture; it reports no live breakages. The fleet dev prompt build and all five
  distribution tests passed; prod retained revision
  `eaa6da86e523229f8353dbbefae985ad68d34546fe5b430f17456664b765b97a`.
- Published `@openclaw/codex` 2026.10.6 and 2026.10.8 have identical bytes for all
  four new operational seams. The 2026.10.8 package was patched, inspected and
  restored in an isolated directory; all six modified bundles restored exactly.
  Existing receipts may safely add newly reviewed bundle targets without losing
  earlier backups or accepting foreign edits. The lifecycle regression covers
  this expansion, idempotence, upstream drift and restoration.
- Request assembly executes unmodified published producers plus the guarded
  patch, covering automatic and explicit-message/private-final delivery, hidden
  commentary, no message tool, required targets, sender/account facts, date/timezone,
  unknown/incognito additions, generic-policy withdrawal and cron's retained
  parent-local instructions. Execution settings and unrelated-agent output stay
  unchanged. Known inherited exec defaults disappear; routing overrides remain
  explicitly Gateway-scoped. Unknown additions are retained.
- A localhost-only Responses receiver captured actual requests from installed
  Codex CLI **0.166.0**, using a temporary home, a patched catalog and dummy
  credentials. Five requests covered a fresh root, an actual full-history native
  child, child-result delivery to its parent, and root resume. Both roles used the
  short catalog text with the native direct-call, shared-filesystem, live-limit,
  wait and fork supplements intact. Native Default-mode prose and explicit-only
  delegation restrictions were absent; an empty `<collaboration_mode>` marker
  remained. Compact permissions rendered `network enabled` and retained the
  escalation-argument constraint. Synthetic responses drove tool execution;
  no model inference or fleet operation was performed.
- Refresh service coverage proves that a successful shared-prompt update survives
  a catalog failure, simultaneous failures identify all three components, hourly
  retry timing is retained, last-known-good snapshots survive, and credential-like
  transport errors do not enter logs.
- Prompt wording was walked through against issue #4's four cases: a relevant
  connected source, no relevant integration, process success with failed payload,
  and a successful tool output. It asks for relevant retrieval and result
  inspection, not exhaustive integration search or mandatory extra file checks.
  This is a policy review, not a measured model-behavior improvement.
- Prompt-copy word counts: bundled system **2033 → 2069**, bundled developer
  **420 → 394**; fleet dev lifecycle **426 → 430**, tool discovery **102 → 118**,
  integrations **51 → 71**. In the inspected catalog, Default-mode prose fell
  **124 → 0** words, root role **185 → 6**, child role **195 → 18**. These are
  wording counts, not a behavior or token-cost benchmark. Production source is
  **+200/-15 lines**; tests and published-source fixtures are **+204/-9 lines**.

Activation is separate: explicit sync, enabled catalog refresh, idle restart and
fresh root/child conversations are required. Pre-existing conversations can retain
deleted context and must not be treated as cleaned. No fleet rollout, live Slack
send/attachment exercise, commit, push, npm publication or prod prompt promotion
was performed. Local captures remain outside the repository. OpenClaw plugin,
fleet-prompt editing and test-audit skills guided the changes; official OpenAI
documentation confirmed that null collaboration instructions request defaults,
and source plus actual wire captures established empty-override behavior.

### Initial issue-fix review map (superseded above)

In `unblock-codex-prompt`:

- Prompt copy: `prompts/system.md`, `prompts/developer.md`.
- Generated native/OpenClaw instructions: `src/catalog.ts`, new `src/context.ts`,
  `src/remote.ts` (empty remote developer policy).
- Guarded assembly and empty-policy support: `src/adapter.ts`, `src/runtime.ts`,
  `src/manager.ts`.
- Refresh diagnostics: `src/index.ts`, new `src/refresh-error.ts`.
- Configuration/documentation: `openclaw.plugin.json`, `README.md`, `VALIDATION.md`.
- Regression coverage: `test/bridge.test.mjs`, `test/catalog.test.mjs`,
  `test/plugin.test.mjs`, `test/refreshable-adapter.test.mjs`.
- New published-source fixtures: `test/fixtures/adapter-operational.json`,
  `test/fixtures/openclaw-additions.json`.

In neighboring `fleet-prompt`, dev only:

- `prompts/dev/sections/02-task-lifecycle-and-progress.md`: visible progress route.
- `prompts/dev/sections/03-tool-discovery-and-use.md`: payload/output verification.
- `prompts/dev/sections/15-apps-mcp-and-integrations.md`: relevant connected lookup
  before asking the user. Prod sections are unchanged.

## 0.2.1 compatibility validation — 2026-10-08

- Retained a clean OpenClaw checkout at `v2026.9.8`
  (`fc23bc864e4553c2d215e479eeec47b67a0bf943`); the original dirty checkout
  was left untouched. Runtime validation used the published OpenClaw and
  `@openclaw/codex` 2026.9.8 packages with Node 24.19.0 in an isolated state,
  configuration and workspace.
- The bridge now discovers the split `dist/.setup/thread-lifecycle-*` and
  `thread-requests-*` bundles, checks the reviewed context carriers, and removes
  the new thread-level skills append only for the enrolled frozen target.
  Schema-2 receipts retain exact originals for each patched file; schema-1
  receipts still restore and migrate on sync. Interrupted upgrades remain
  recoverable; foreign edits are refused before restore changes any bundle.
- Adapter runtime imports use the loader's durable `runtimeSource` (or `source`
  on older hosts), not the temporary execution capture. Real 2026.9.8 CLI sync,
  restore and resync passed; both restored bundles matched their original bytes.
  The final packed candidate's installed adapter and entrypoint matched the build.
- In a separate process after CLI exit, imported the actual patched 2026.9.8
  bundles and exercised their exported request/context assembly: frozen policy
  loaded successfully, routing/coauthor text and cron guidance survived, live
  context/skills were suppressed, and foreign prompt edits failed closed.
  Actual published 2026.9.2 and 2026.9.4 packages also passed install, syntax,
  status and exact-byte restore checks.
- A separate isolated installation pinned both OpenClaw and Codex to 2026.9.3.
  Real CLI sync succeeded; frozen policy loaded after CLI exit, other-agent
  behavior remained unchanged, and restore recovered the exact original bytes.
- Using the actual patched 2026.9.8 thread-request builder and Codex 0.158.0
  app-server, captured two fresh native threads at a localhost-only Responses
  receiver with no real credentials. Both requests carried the complete frozen
  base exactly once, the frozen developer policy and routing/coauthor text, and
  omitted the separate live skills append. Synthetic responses completed; the
  isolated provider configuration was restored byte-for-byte afterward.
- `npm run preflight`: **34 tests pass**, build and both Inspector checks pass,
  package check passes (29 files). The same two Inspector advisory evidence gaps
  remain: isolated dependency-install and service-capture proof. The split-layout
  regression failed on pre-fix code with `Unsupported Codex bundle layout`.
  `git diff --check` passes.

Limits: this proves real CLI lifetime, packaged request assembly and native
Responses wire composition, not general policy obedience or the full Gateway
turn path. No
operator Gateway, existing sessions, fleet configuration or credentials were
changed during isolated validation. Publication and fleet activation are separate
release steps; these checks alone do not establish fleet adoption.

## 0.2.0 Codex skills removal — 2026-09-29

- Codex listed 14 native skills on Bill, including four ChatGPT Pages and three
  Pets skills from remote plugins that sync in on their own. They reached every
  OpenClaw session (43 of 45 sessions that day carried the skills list).
- New `disabledCodexSkills` (default `["pages", "work-pets"]`) writes one marked
  block of `[[skills.config]] name = "…" enabled = false` rules. Codex matches
  plugin skills as `plugin:skill` by name in 0.153.4, 0.155.0-alpha.9.2 and 0.159.1
  source. Name rules were verified in a codex 0.159.1 capture lab: folder `path`
  rules are ignored, `SKILL.md` paths and names work.
- Against a copy of Bill's real skill/plugin tree and config.toml, discovery named
  exactly the seven Pages/Pets skills his live list shows; the block parsed with his
  config and left everything above it byte-identical. Discovery also sees on-disk
  skills Codex does not load (openai-templates, review-agent); the remove list only
  writes rules for listed names.
- `npm run preflight`: 31 tests pass, both Inspector checks pass (same two advisory
  gaps), package check passes. Live verification follows on Bill before rollout.

## 0.1.1 candidate and fleet alignment — 2026-09-21

- Removed the exact 2026.9.2 version/bundle-name pin. The bridge now accepts
  OpenClaw and `@openclaw/codex` stable releases >=2026.9.2 while checking the
  reviewed context-assembly functions. Unknown changed layouts fail closed.
  Reviewed actual 2026.9.2 and 2026.9.4 bundles patch successfully and pass
  `node --check`; the latter includes the separate parent-local context path.
- `npm run preflight`: **29 tests pass**, both Inspector checks and package check
  pass. The same two advisory Inspector evidence gaps remain, with zero
  breakages. `npm run release:check -- v0.1.1` and `git diff --check` pass.
  Focused tests cover both layouts, default/cron behavior, target isolation,
  extra/coauthor context, version floor, renamed bundles, exact restore and
  foreign-edit/path refusal. The package check includes the new version guard.
- Installed the local 0.1.1 candidate on Rocky only, retaining OpenClaw/Codex
  2026.9.4. Enrolled prod Fleet Prompt with 42 eligible skills. Installed runtime
  files match the local build. OpenClaw config differences are confined to this
  plugin's config; managed Codex TOML adds only `model_instructions_file`.
- Refreshed/synced all 12 included Codex nodes to shared revision
  `63846ac122de4df682c0181ebc86223c864aee57e870cec49f1838cc1a13720a`:
  Bill stays dev; all others use prod. Both live endpoints return HTTP 200 and
  the matching SHA-256. The master defaults native Codex Computer Use and says
  to notify Bek about issues. Mika was held without mutations; Bridger excluded.
- All 12 fresh, non-delivering real-provider canaries returned the requested
  acknowledgement through the Codex harness, without tool calls or rerouting.
  Native session records match the complete installed base, contain the updated
  native AGENTS.md and frozen SOUL, and omit duplicate SOUL/generic OpenClaw
  developer policy. Theo/Pearl/Rocky initially rejected test-only model/thinking
  overrides; retrying with their configured defaults passed without policy edits.
- Final status reports enrolled/ready with matching pointers and installed
  adapters on all 12. Live schedule log entries exist for 11; James's running
  service logged a successful automatic daily refresh earlier the same day.
  Ten required restarts used idle checks and indefinite drain, without session
  resets; Gateway RPC checks passed. Bill and James required no restart.
- Trimmed 21 local instruction documents by 9,484 whitespace-delimited words,
  retaining local identities, customer boundaries and Bek's protected exceptions.
  Cherry's legacy file was moved into a verified same-host recovery backup.
  Its old config reference was nested in a project table, not an active top-level
  pointer; standalone Codex now has the correct top-level managed prompt pointer.

Limits: this proves composition and basic inference, not general policy obedience
or computer-use operation. Existing conversations were not reset. No elapsed
24-hour wait or unseen-version compatibility claim is made. Bill's existing
frozen USER snapshot differs from his current USER.md; the shared-only refresh
deliberately preserved it. Rocky retains an existing update-history warning about
the Gateway Node version, despite successful Gateway/inference checks; no Node
upgrade was included. Source changes remain uncommitted, and 0.1.1 is not published
to npm/GitHub. Existing 2026.9.2 nodes retained their working bridge installations.

Private per-node evidence, original/proposed documents and recovery paths are in
`/tmp/fleet-prompt-align-20260921-UXUDCk/REPORT.md`, outside the package. The fleet
prompt editing skill guided deduplication while preserving exceptions; OpenClaw
plugin skills guided compatibility/package/lifecycle checks, and OpenAI Docs
confirmed the top-level instruction-file configuration boundary.

## Published 0.1.0 — 2026-09-12

- Published `@unblocklabs/unblock-codex-prompt@0.1.0` to npm (`latest`) and created
  GitHub Release `v0.1.0` at `a6b8eccc0b3ea2c6bc48c530c19b7c2484994a89`.
  CI and the Release workflow passed; the release job verified the npm tarball
  was identical to its packed artifact. This first local bootstrap has no Actions
  provenance. The npm trusted publisher now permits this repository's
  `release.yml`; publishing a future new version through OIDC remains unexercised.
- Installed the exact npm version on Bill. OpenClaw moved it from the development
  extensions directory to its managed npm project and removed the old install.
  A private tar backup retains the previous install. The adapter reference was
  relinked to the new runtime path without recompiling the frozen agent context.
- Normal managed Codex routing, frozen context bytes, source hashes, and skill
  count were preserved. Refresh succeeded for the dev prompt and 12-model catalog;
  runtime inspection returned no diagnostics and Gateway health passed.
- A fresh, non-delivering real-provider Sol canary returned the requested
  acknowledgement. This verifies basic inference through the released package,
  not general prompt obedience. No other fleet node or Worker was changed.

## Daily shared Cloudflare prompt refresh — 2026-09-12

- An enrolled `promptUrl` now participates in the daily service, including overdue
  startup catch-up. `codex-prompt refresh` checks the shared prompt and enabled
  model catalog immediately. No Worker deployment or new configuration is needed.
- Shared-prefix replacement preserves the frozen context bytes, source hashes,
  skill count, and developer pointer policy. It never rebuilds agent documents
  or skills. Unchanged prompt content does not rewrite the prompt file.
- Bill's existing remote snapshot migrated automatically on startup, preserving
  the complete unchanged prompt. A temporary local-only revision marker was then
  inserted into the shared prefix. No Cloudflare prompt was modified.
- Before/after requests captured through Bill's localhost receiver: Astra with
  the marker, Astra after refresh without restart, and Sol after refresh. The
  latter requests contain the real Cloudflare dev prompt without the marker.
  All contain the exact compiled prompt once and retain frozen context, native
  AGENTS.md, delegation mechanics, and tool declarations; the restrictive
  `<multi_agent_mode>` remains absent.
- The capture provider deliberately lacked catalog authentication. Combined
  refresh reported that failure but still updated the shared prompt successfully.
  After restoring the configured provider, both refresh components succeeded.
- A second local marker with an overdue timestamp was removed automatically by
  service startup. All frozen source hashes and the 48-skill count were preserved.
- `npm run preflight`: **26 tests pass**, both Inspector checks and package checks
  pass (same two advisory Inspector evidence gaps). New focused tests cover
  prefix-only replacement, unchanged-file behavior, validation failure retention,
  legacy/ambiguous boundaries, restored enrollment, and receipt-write rollback.
- Installed runtime files match the local build hashes. Bill's normal API config
  was restored byte-for-byte; Gateway health passed and the receiver stopped.
  No npm release, GitHub push, other-node deployment, or Cloudflare write occurred.

These synthetic captures prove request composition, not real-model obedience.
Fresh-session adoption is verified on managed Codex 0.153.4 with OpenClaw and its
Codex plugin 2026.9.2; existing conversations were not reset or tested for adoption.
Daily interval/retry behavior is fake-clock tested, with live overdue startup
verification rather than an elapsed 24-hour wait. OpenClaw plugin skills guided
package/lifecycle validation; OpenAI Docs confirmed the instruction-file surface.

The following sections are historical; their explicit-sync-only shared-prompt
limitations are superseded by the daily shared-prompt behavior above.

## Daily model-catalog refresh — 2026-09-12

- Implemented and enabled the opt-in catalog service on Bill. It fetches fresh
  metadata from his configured provider, preserves model metadata except
  `model_messages.multi_agent.mode.explicit`, and manages `model_catalog_json`.
  All 12 models have that explicit-delegation-policy field set to an empty string.
- Deliberately changed every generated model's display name and explicit policy
  to a diagnostic marker. A fresh Astra request contained the altered policy.
  `openclaw codex-prompt refresh-catalog` removed both edits from fresh upstream
  metadata. A second fresh Astra request, **without a Gateway restart**, omitted
  the marker and `<multi_agent_mode>` block.
- Further fresh Astra and Sol requests after restart also omit the restrictive
  block. Each contains the exact XML-wrapped compiled prompt once, native
  AGENTS.md, skills/Default-mode guidance, delegation mechanics, and actual tool
  declarations (carried as an `additional_tools` input item on this Codex build).
  Astra's delegation mechanics were byte-identical across its three captures.
- The initial Sol check incorrectly required `<multi_agent_role>` wrappers.
  Inspection showed Sol's native mechanics are present without that wrapper;
  corrected read-only checks against all four retained requests pass. This was
  a test assertion error, not missing runtime instructions.
- Damaged the generated catalog again and made its refresh receipt overdue.
  Gateway service startup repaired it automatically. The final catalog hash
  matches its receipt, with last/next refresh timestamps 24 hours apart.
- `npm run preflight`: **22 tests pass**, including repair, upstream failure
  retention, ownership/restore, provider authentication, and fake-clock daily
  scheduling/hourly retry/stop. Both Inspector checks and package checks pass;
  the same two advisory proof gaps remain. A real 24-hour wait was not performed.
- Normal API routing was restored byte-for-byte against the pre-capture config;
  Gateway health passed and the test receiver stopped. Only Bill was updated.
  No npm publication, GitHub push, or Worker deployment occurred.

Catalog-only refresh does **not** refresh the shared Worker prompt or frozen
workspace/skills snapshot. Those still require explicit `sync`. First catalog
pointer activation was tested with a restart; content-only refresh was adopted
by a fresh conversation without one. Existing-conversation adoption was not
tested. Results are pinned to managed Codex 0.153.4 and OpenClaw/Codex plugin
2026.9.2. The receiver returns synthetic replies: these tests prove request
composition, not model obedience or tool execution.

OpenClaw plugin skills guided package/lifecycle validation; OpenAI Docs supplied
the documented `model_catalog_json` configuration surface.

## Fleet Prompt dev endpoint — 2026-09-12

- Configured Bill with `promptUrl` selecting Fleet Prompt's dev channel. The
  packaged plugin fetched and SHA-256-validated the public HTTPS response during
  explicit sync. No customer context was uploaded to the Worker.
- `npm run preflight`: **17 tests pass**, build, both Inspector checks and packed
  file checks pass. Inspector retains two advisory proof gaps; real installed
  runtime inspection imported the plugin, found its service/CLI, and returned no
  diagnostics. No npm publication or GitHub push was performed for this change.
- Two fresh no-delivery Responses requests, Astra and Sol, each contain exactly
  one complete remote policy inside exactly one compiled base. This Codex build
  carries the base as a developer input item, not top-level `instructions`.
- Remote policy: **27,932 bytes**,
  SHA-256 `decbcffc93f21e5c71c05bf0a92ab07c2f040d030833c282345b3ca402d73880`.
- Compiled local snapshot: **48,481 bytes**, 48 eligible OpenClaw skills,
  SHA-256 `a922a41e99d75004fa87f81f6a0793fe26ef4022a034ab4e581414e67a767a72`.
  Codex trims outer whitespace in the request; exact comparison accounts for it.
- The former bundled OpenClaw developer policy and generic OpenClaw policy are
  absent. A short pointer to the shared base replaces that policy layer. Live
  OpenClaw soul, memory and skills contributions remain suppressed, with local
  frozen context present in the compiled base.
- Native AGENTS.md, native skills, Default-mode guidance, native multi-agent
  instructions, permission/executor instructions, temporal context and actual
  tool declarations remain separate. This does **not** suppress every developer
  message or every other plugin's contribution.
- The temporary localhost Responses provider was removed; Codex TOML matches
  its pre-deployment bytes exactly. Gateway health passed after restarting onto
  normal routing. The receiver stopped; private backups/captures remain on Bill.

The existing receiver returns synthetic replies. These captures establish prompt
composition, not model obedience or execution of tools. No customer-facing
messages were requested. Worker deployments still require explicit plugin sync
and activation on each node; there is no automatic fetch on startup or per turn.
Existing conversations were not reset. Only Bill was updated.

OpenClaw plugin skills guided package and live-runtime validation; OpenAI Docs
confirmed the model-instructions-file replacement boundary.

## Prior validation — 2026-09-10

## Frozen bridge validation (current implementation)

- `npm run preflight`: **14 tests pass**, TypeScript/build and package checks pass.
  Both inspector checks pass with the same two advisory proof gaps (dependency
  installation and service capture), not live compatibility findings.
- Real installed-package inspection on Bill returns no diagnostics. Runtime
  registration remains one service and one CLI; no prompt hook or HTTP relay.
- The compatibility SHA-256 matches both Bill's original adapter and the published
  `@openclaw/codex@2026.9.2` npm artifact. Actual-bundle integration checks cover
  syntax, install/idempotence, foreign-edit refusal, exact restoration and reinstall.
- Five fresh Responses requests captured on Bill: Astra A, Sol A, unsynced Sol A,
  Astra B, Sol B. Each has the exact frozen base once, reviewed developer policy
  once, all 48 approved OpenClaw skills, and no live copies of the three suppressed
  blocks. Native AGENTS.md, native skills, Default guidance and tool contracts remain.
- Editing SOUL.md and restarting did not change the frozen prompt. Explicit sync
  included the temporary marker in both models' new requests. The edit was restored.
- Sol's tool declarations are byte-identical to the earlier baseline. Astra retains
  the same tool interfaces; native spawn-agent model descriptions changed with the
  live catalog (outside this patch).
- Real Astra canary: code-mode discovery, OpenClaw Gateway exec read, native
  `spawn_agent`, and native `wait_agent` all executed. The child computed 323 and
  its recorded base instructions exactly match the compiled parent prompt.
- Bill's disk restore/re-enroll round trip recovered the exact original adapter,
  then returned TOML, prompt and enrollment to their pre-test bytes. The running
  Gateway was not restarted while temporarily restored; this was a disk rollback
  test, not a claim about restored old-session behavior.
- Temporary endpoint and SOUL changes were restored. Bill is healthy with no plugin
  errors; operational model/tool/channel/skill/Gateway settings are unchanged.

The localhost receiver returns synthetic completions: capture tests prove request
composition, not model obedience. The separate real-provider canary proves the
specific exercised tools and native-child inheritance, not every fleet workflow.
Cron preservation and non-target/disabled behavior are source/unit-tested, not
live multi-customer rollout tests. Existing sessions and future OpenClaw versions
are not covered. Only Bill was deployed; no npm release or fleet rollout occurred.

The OpenClaw plugin skills guided package/SDK/preflight checks; OpenAI Docs guided
the model-instructions-file boundary. Private captures and customer files are
retained outside this repository and are never packaged.

## Earlier base-only validation (historical)

The results below describe the initial base-only plugin, before the frozen bridge.

## Local

- Clean `npm ci`, TypeScript build, and all 11 focused tests passed.
- Plugin Inspector static and isolated mock-SDK checks passed, with no live
  compatibility findings. Its two advisory proof gaps concern isolated dependency
  installation and service-registration evidence; both were checked independently
  through an installed package and real-SDK/runtime inspection.
- Separate real-SDK capture observed exactly `registerService` and `registerCli`.
  No prompt hooks, tools, or HTTP routes were registered.
- The package allowlist contains the compiled runtime, Markdown template,
  manifest, license, and user documentation. No captures, backups, or work files.
- Package, lockfile, and manifest versions match `0.1.0`.

## Live Bill test

Environment: dedicated Mac Mini, OpenClaw and official Codex plugin `2026.9.2`,
managed Codex CLI `0.153.4`. Probes explicitly selected `openai/gpt-5.6-sol`
without changing Bill's default model.

Installed the local npm tarball through OpenClaw, accepted its capabilities,
configured `agentName: "Bill"`, and explicitly adopted his existing pointer.
The generated prompt was byte-for-byte identical to his original contract:

```text
13769 bytes
sha256: 35304debde563f20862355ed00812d003028b51c2471c1bffd0e842bb0a56363
```

Used Bill's existing localhost-only Responses capture server, with a private,
test-specific capture directory and separate no-delivery probe conversations.
The temporary receiver returned synthetic completions; it did not call a model.

1. Captured the canonical template in a fresh native Codex thread.
2. Added a harmless revision marker to the installed template, ran the plugin's
   `sync`, restarted safely, and captured another fresh native thread.
3. Verified that both requests contained exactly one full rendered contract,
   allowing only outer-whitespace trimming. The marker was absent in A and present
   in B; the native thread IDs differed. Separate OpenClaw developer policy was
   present in both requests.

**Wire-format finding:** this Codex build emits the base contract as the second
developer item in `input`; it omits the top-level `instructions` field. An initial
assertion looking only at `instructions` correctly failed, triggering restoration.
The revised test checked the actual carrier and exact normalized content instead.

The original endpoint configuration was restored byte-for-byte to its
pre-capture state, retaining only the plugin-managed prompt pointer. The temporary
template change was removed, the canonical prompt re-synced, and the Gateway
restarted. The test receiver was stopped. Original prompt files and private
rollback material were retained on Bill, not published here.

A subsequent **real model** probe on the restored endpoint correctly identified
Bill's identity, the dedicated Mac Mini, the operating-contract title, and that
unchanged state during monitoring is expected rather than a blocker. The terminal
receipt reported the Codex harness, the requested model, no reroute, and no tool
calls. This is a bounded behavior check, not proof of compliance with every rule.

Live `restore` reproduced the entire original Codex TOML byte-for-byte;
`sync --adopt` reproduced the managed version exactly. After reinstalling the
canonical tarball and restarting, Gateway/RPC health passed, runtime inspection
reported the service and CLI loaded with no diagnostics, and startup logs showed
an idempotent sync of the canonical hash. Agent/model/channel/auth configuration
was unchanged. Bill remains enrolled on the canonical prompt.

OpenClaw `2026.9.2` labels the local archive install `provenance-invalid`. Its
installed `resolvePluginTrust` implementation assigns that fallback to this
archive source; it is not an artifact-content tamper verdict. The explicit local
install is loaded and works, but is not a trusted-official distribution. No trust
policy was weakened to suppress this classification.

Disk status deliberately continues to say `runtimeVerified: false`: live evidence
is from the captured requests and behavior probe, not a permanent status claim.

## Publication boundary

The repository is public. The npm release workflow is prepared but no GitHub
Release, release tag, or npm publication was created. First publication still
requires npm package/scope authorization and trusted-publisher or token setup.
GitHub CI passed on the initial public commit, including Linux clean dependency
installation, all tests, both Inspector checks, and package-content validation.
