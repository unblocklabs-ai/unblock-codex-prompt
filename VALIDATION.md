# Validation

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
