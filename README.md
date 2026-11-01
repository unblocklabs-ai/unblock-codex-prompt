# Unblock Codex Prompt

A small, explicit prompt-management bridge for dedicated OpenClaw Mac agents.
**Version 0.3.0.** The frozen bridge supports OpenClaw/Codex 2026.9.2 and newer
stable releases with a compatible context-assembly layout.

## What you control

- Required `promptUrl`: the shared policy compiled from Fleet Prompt's dev/prod
  sections and served by Cloudflare. It is the only shared-policy source.
- Each agent's local snapshot of `SOUL.md`, `IDENTITY.md`, `USER.md`, its eligible
  model-visible OpenClaw skills catalog, and a memory reference (not memory bodies).

The generated instructions replace Codex's base through `model_instructions_file`.
A narrowly patched Codex adapter also replaces OpenClaw's generic developer
policy and suppresses the separate soul, memory and OpenClaw-skills
contributions to collaboration instructions. Cron guidance remains in its existing
parent-local carrier. The optional managed catalog removes native Default-mode prose.

There are no bundled system/developer templates or base-only mode. Downloaded
policy and frozen agent context are written only to
`<agentDir>/codex-home/unblock-codex-prompt.md`, outside the plugin directory.
Codex reads that generated file; the plugin package does not retain its own copy
of the downloaded policy.

**Still live and untouched:** native AGENTS.md, native skills, tool schemas and
executor protocol, sandbox/approvals, native collaboration mechanics, routing
identifiers, date/timezone and user messages. Reviewed duplicate OpenClaw prose is
normalized; unknown `extraSystemPrompt` additions, including incognito context, survive. This is not total
prompt ownership; other plugins/hooks can still add instructions.

Customer documents stay on each agent's machine, outside this package. Snapshot
files use private permissions. Missing identity documents are recorded as absent.

## Compatibility

- Frozen bridge: **OpenClaw and @openclaw/codex >=2026.9.2**. Reviewed layouts cover
  2026.9.2, 2026.9.3, 2026.9.4, 2026.9.8, 2026.9.9, 2026.10.6 and 2026.10.8, including parent-local context,
  refreshable instructions and split `dist/.setup/` bundles. Bundle names
  may change; fingerprints of the context-assembly functions must still match.
  Changed assembly is refused pending review, rather than patched blindly.
- Local stdio Codex with an OpenClaw agent-scoped home. Operator-selected
  `appServer.command` and `appServer.args` are supported and left unchanged.
  The launcher must honor OpenClaw's `CODEX_HOME` and must not override the
  managed `model_instructions_file`; status cannot attest to launcher behavior.
- One target agent per installation. Other agents use upstream behavior. Native
  children may inherit the parent's frozen context.

This bridge uses two private upstream seams because public prompt hooks cannot
fix the dropped-context path: one skill-catalog builder and guarded Codex context
carriers. Older builds require parent-local suppression and removal of the
separate thread-level skills append. The 2026.10.6/2026.10.8 recipe suppresses live
persona, memory and OpenClaw skills at their producers, so initial threads, reuse,
parent-local inference and compaction all receive the frozen context. Native
AGENTS and operational context remain live; cron guidance and execution permissions
are unchanged. On reviewed 2026.10.6/2026.10.8 layouts, the adapter additionally
removes active-computer context, known Slack participation/style/activation policy,
duplicate progress-card prose and basic Markdown tutorials. It compacts source
delivery to current facts and scopes meaningful exec overrides to OpenClaw Gateway
exec; inherited steady-state defaults are omitted. Unrecognized additions are
preserved, not removed by heading. Older layouts retain their original per-turn
operational carriers. Changed operational functions require review before sync.
The installer backs up and tracks every
patched bundle; old single-file receipts remain restorable. Runtime module paths
come from the loader's selected entry, never its temporary execution capture.
It validates private seams and is not a promise of compatibility with unseen layouts.
The catalog uses OpenClaw's eligibility, allowlist, visibility and size-limit
logic. Session-specific and execution-directory skills are not snapshotted.
Remote-node-only skills are not added; this is for dedicated local Mac agents.

## Install and enroll

```sh
npm ci
npm run preflight
npm pack
openclaw plugins install ./unblocklabs-unblock-codex-prompt-0.3.0.tgz --force --accept-capabilities
```

Include the plugin in `plugins.allow` if applicable, then configure:

```json5
{
  plugins: {
    entries: {
      "unblock-codex-prompt": {
        enabled: true,
        config: {
          agentId: "main", frozenContext: true,
          promptUrl: "https://fleet-prompt.unblocklabs.ai/prompt?channel=dev"
        }
      }
    }
  }
}
```

`agentId` defaults to `main`. Both `promptUrl` and `frozenContext: true` are
required. Legacy `agentName` values remain accepted but are unused; identity comes
from local agent documents. Existing remote fleet configurations need no changes.
Configurations without a remote URL or with base-only mode are no longer supported.
No conversation-access hook grant is needed. Initial enrollment enables daily shared-prompt refresh
and overdue startup catch-up. Startup never rebuilds local context or patches the
adapter. The optional model-catalog service can also refresh metadata.

Use `channel=dev` for Bill and `channel=prod`
for approved fleet deployments. The URL must use HTTPS without embedded credentials
or a fragment. Sync fetches without authentication, refuses redirects, and checks
plain-text content, a 256 KiB limit, UTF-8, and the endpoint's SHA-256
`X-Prompt-Revision` header, with a ten-second request timeout. These integrity
checks are not a signature; the configured HTTPS publisher controls the policy.

The remote text supplies the shared Codex base; the OpenClaw generic developer
policy is empty rather than a second shared-policy copy. Empty policy is valid
only within the normal hash/pointer-validated frozen
bundle. The frozen local context is still appended.
No local documents are sent to the Worker. The installed snapshot is the local
last-known-good generated file in the agent's managed home: a failed fetch aborts
sync before writes and does not disrupt normal turns. There is no bundled fallback. Status shows
the installed URL/revision separately from the configured URL, without fetching.

Back up configuration and drain active work. Inspect the installed official
Codex package location, then use that exact directory:

```sh
openclaw plugins inspect codex --json
openclaw codex-prompt sync --adopt --codex-plugin-dir /absolute/path/to/@openclaw/codex
openclaw codex-prompt status
```

`--adopt` explicitly takes ownership of an existing custom prompt pointer. Its
previous value is retained for restoration; leave the original file in place.
First frozen sync compiles local documents/catalog and installs the guarded
adapter patch with a private original-source backup. Later syncs reuse its receipt.

## Refresh and activate

```sh
openclaw codex-prompt sync
openclaw codex-prompt status
```

Only explicit `sync` rebuilds local documents, skills, and the adapter policy.
The daily service fetches the configured Worker channel and
replaces only the shared prompt prefix when its content changes. The existing
frozen context is preserved byte-for-byte, without rereading workspace files.
Editing a source document or restarting does not rebuild that local snapshot.
Skill bodies remain files the model reads when triggered; their contents are not
frozen. The catalog and its selection are frozen.

**After sync, drain work, restart the Gateway/managed app-server, and use new
conversations.** Existing native threads may retain earlier base instructions.
The plugin never interrupts or resets sessions. Capture an actual request after
provisioning or upgrades; `status` is disk evidence, not live adoption.

For this instruction cleanup, run explicit `sync` to install the new adapter and
empty remote policy, refresh the enabled catalog, then restart while idle and use
fresh root/child conversations. Daily prompt refresh alone does not replace a
snapshot's developer policy or install an adapter. New turns on a newly activated
conversation stay normalized, but old conversations can retain removed
active-computer, permission, role or routing text. Do not reuse them to validate
the cleanup. Warm generic-policy changes explicitly withdraw removed sections;
they cannot erase unrelated creation-time context.

The patched assembly boundary validates enrollment, pointer and compiled prompt
hash before replacing/suppressing context. Invalid state aborts assembly.
This guard does not attest to an old thread's retained prompt or detect every
possible higher-priority Codex config override. An upgrade replacing the adapter
removes the guard; startup status is diagnostic, not a global inference gate.
Restore before upgrading, then revalidate compatibility before reenrollment.

If an upgrade already removed the old package generation, do not run restore
against replacement files or rewrite receipt paths. Verify that every old target
is absent and each retained original backup matches its receipt hash, privately
archive the stale receipt, then install the reviewed adapter against the current
inspected official package. Keep the frozen snapshot and operator-selected launcher intact
unless a new snapshot was requested. A source update still requires idle activation
and fresh-session verification; disk status alone does not prove adoption.

### Daily shared-prompt refresh

No additional setting is needed beyond an enrolled `promptUrl`. The service checks
every 24 hours while the Gateway runs and catches up when overdue on startup.
Use `openclaw codex-prompt refresh` to run the same remote-prompt and enabled
model-catalog refresh immediately, without resnapshotting local context.

Both components are attempted independently: a catalog outage cannot prevent a
prompt update, or vice versa. Failed fetches or validation keep the installed
copy; failures retry hourly. Unchanged prompt content is not rewritten. Status
includes the remote revision and last successful `checkedAt` timestamp. Updates
are intended for fresh conversations; existing conversations are left alone.
The plugin never restarts the Gateway automatically.

Existing remote snapshots migrate their shared/context boundary without rereading
agent files. Ambiguous or externally modified snapshots are refused rather than
guessed; inspect them and use explicit `sync` to rebuild when appropriate.

## Optional daily model-catalog refresh

Set `suppressExplicitDelegationPrompt: true` alongside `frozenContext: true`, then
run `openclaw codex-prompt sync` (or `openclaw codex-prompt refresh-catalog` for
catalog-only updates on an already enrolled agent).

The plugin fetches the configured Codex provider's `/models` endpoint using its
existing `env_key` credential. The credential must be available in the OpenClaw
process environment; OAuth-only/command-auth providers are not implemented. The
endpoint must return a full Codex `models` catalog, not only an OpenAI-style
`data` list. The managed model cache supplies only the client-version query
parameter, never the catalog contents.

The existing `suppressExplicitDelegationPrompt` opt-in manages these fields on
each model, preserving unrelated metadata and other permission/mode messages:

- `multi_agent.mode.explicit`: empty, preserving standing useful delegation.
- `collaboration_modes.default`: empty, leaving runtime mode selection unchanged.
- `multi_agent.role.root` / `subagent`: compact role identity and child-result delivery.
  Codex still appends its live executor/shared-state/concurrency/fork guidance.
- `permissions.danger_full_access`: `Native execution: filesystem unrestricted; network {{ network_access }}.`
- `approvals.never`: `Approval escalation unavailable; omit sandbox_permissions.`

All paths above are under `model_messages`. Empty catalog strings are intentional
overrides, not `null` fallback values. The changes affect instruction text, not
tool definitions, execution settings, approval enforcement or Plan mode. The plugin
writes `unblock-codex-models.json` in the managed Codex home and sets the top-level
`model_catalog_json` pointer. It refuses to overwrite another owner's pointer.
Manual edits to this generated catalog are intentionally replaced on refresh.

While the Gateway is running, the service refreshes every 24 hours and catches
up if overdue on startup. Failures retain the installed catalog and retry hourly;
there is no fallback to stale cached metadata. Stopping the service cancels its
timer and waits for an in-flight refresh. Status exposes last/next refresh times
and verifies the local catalog hash without fetching. A successful catalog-only
`refresh-catalog` never changes the fleet prompt or local context snapshot. The
daily service and `refresh` also check the shared prompt.
Failures report every failing component, a safe cause and the next hourly retry
time; transport details, configuration snippets and response bodies are not logged.

Restart the Gateway after first activating the catalog pointer. On the validated
managed Codex 0.153.4 build, a fresh conversation adopted refreshed catalog
contents without a Gateway restart. Content-only updates report
`newSessionRequired: true`, but `restartRequired: false`. Existing conversations
are not reset, and their adoption is not guaranteed. The plugin never restarts
the Gateway automatically; revalidate this behavior when upgrading Codex.

## Codex skills removal

Codex lists every skill it finds in the managed Codex home, including skills from
ChatGPT remote plugins that sync in on their own. `disabledCodexSkills` names the
ones to remove: a plugin name removes all of that plugin's skills, and an exact
skill name (`pages:write-page`, `imagegen`) removes one. It defaults to
`["pages", "work-pets"]` (ChatGPT Pages and Pets). Other skills are untouched.

```json
"disabledCodexSkills": ["pages", "work-pets"]
```

The plugin scans `skills/` and `plugins/cache/` under the managed Codex home and
writes one marked block of `[[skills.config]] name = "…" enabled = false` rules at
the end of `config.toml`. It re-applies the block at Gateway startup, `sync`,
`refresh`, and the daily refresh, so newly synced plugin skills are caught.
Codex reads the rules when its app-server starts; running sessions keep their
list until the Gateway or app-server restarts. Set `[]` to remove the block.
`restore` also removes it. User-authored `[[skills.config]]` entries stay as written.

## Restore

```sh
openclaw codex-prompt restore
openclaw codex-prompt status
```

Restore recovers exact original adapter bytes, deactivates enrollment and restores
the previous TOML pointer. It refuses foreign edits and retains backup, receipt
and generated files. Restart and use fresh conversations to activate it.
Restore **before** disabling/uninstalling or changing target agents. Disabling
without restoring leaves the frozen base but re-enables live injections.

## Safety and scope

- No model-provider endpoint, model, credential or permission changes. Explicit
  sync/daily refresh can download the public prompt; opt-in catalog refresh uses the existing
  provider authentication path. Credentials are never written into catalog files.
- Parsed TOML edits preserve unrelated bytes. Regular-file checks, atomic swaps,
  concurrency checks and a prompt sync lock protect updates. There is no
  cross-file transaction; inspect a failed sync and rerun after resolving errors.
- Do not run concurrent sync/install/restore operations. If a crash left an empty
  lock directory, confirm no sync is running before removing it.
- A prompt guides behavior; it is not a security boundary or obedience guarantee.
- Frozen prompts do not inherit upstream base-policy improvements. Review upgrades.
- Never commit customer snapshots, raw captures, credentials or host backups.

## Development and release

```sh
npm run preflight
npm run release:check -- v0.3.0
```

Tests cover compilation, explicit refresh, native/private-body exclusion,
target/disabled/restored behavior, cron/default preservation, malformed state,
pointer ownership and foreign edits. See [VALIDATION.md](VALIDATION.md) for live
proof and limits.

Install with
the packed archive above for an unreleased candidate. After publication, use
`openclaw plugins install npm:@unblocklabs/unblock-codex-prompt@0.3.0 --accept-capabilities`.
The existing [GitHub Release workflow](RELEASING.md) publishes npm only when a
GitHub Release is published. Normal pushes do not release the package.

References: [Codex configuration](https://developers.openai.com/codex/config-reference),
[OpenClaw Codex hook boundaries](https://docs.openclaw.ai/plugins/codex-harness-runtime/hooks).
