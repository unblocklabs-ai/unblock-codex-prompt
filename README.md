# Unblock Codex Prompt

A small, explicit prompt-management bridge for dedicated OpenClaw Mac agents.
**Version 0.1.1.** The frozen bridge supports OpenClaw/Codex 2026.9.2 and newer
stable releases with a compatible context-assembly layout.

## What you control

- Optional `promptUrl`: a shared policy from Fleet Prompt, replacing both bundled
  policy files below. Agent-specific identity still comes from local documents.
- `prompts/system.md`: the shared Codex operating contract, with an optional name.
- `prompts/developer.md`: the reviewed OpenClaw integration policy.
- Each agent's local snapshot of `SOUL.md`, `IDENTITY.md`, `USER.md`, its eligible
  model-visible OpenClaw skills catalog, and a memory reference (not memory bodies).

The snapshot replaces Codex's base instructions through `model_instructions_file`.
With `frozenContext` enabled, a narrowly patched Codex adapter replaces the generic
OpenClaw developer policy and suppresses only the soul, memory and OpenClaw-skills
contributions to collaboration instructions. Default-mode and cron guidance remain.

**Still live and untouched:** native AGENTS.md, native skills, tool schemas and
executor protocol, sandbox/approvals, native collaboration, channel/time/routing
context and user messages. `extraSystemPrompt` is retained. This is not total
prompt ownership; other plugins/hooks can still add instructions.

Customer documents stay on each agent's machine, outside this package. Snapshot
files use private permissions. Missing identity documents are recorded as absent.

## Compatibility

- Frozen bridge: **OpenClaw and @openclaw/codex >=2026.9.2**. Reviewed layouts cover
  2026.9.2 and 2026.9.4, including the newer parent-local context path. Bundle names
  may change; fingerprints of the context-assembly functions must still match.
  Changed assembly is refused pending review, rather than patched blindly.
- Managed local stdio Codex, agent-scoped home, no custom command/arguments.
- One target agent per installation. Other agents use upstream behavior. Native
  children may inherit the parent's frozen context.

This bridge uses two private upstream seams because public prompt hooks cannot
fix the dropped-context path: one skill-catalog builder and two entry points in
one Codex adapter bundle (plus the parent-local context entry point on newer builds).
It validates private seams and is not a promise of compatibility with unseen layouts.
The catalog uses OpenClaw's eligibility, allowlist, visibility and size-limit
logic. Session-specific and execution-directory skills are not snapshotted.
Remote-node-only skills are not added; this is for dedicated local Mac agents.

## Install and enroll

```sh
npm ci
npm run preflight
npm pack
openclaw plugins install ./unblocklabs-unblock-codex-prompt-0.1.1.tgz --force --accept-capabilities
```

Include the plugin in `plugins.allow` if applicable, then configure:

```json5
{
  plugins: {
    entries: {
      "unblock-codex-prompt": {
        enabled: true,
        config: {
          agentId: "main", agentName: "Bill", frozenContext: true,
          promptUrl: "https://fleet-prompt.unblocklabs.ai/prompt?channel=dev"
        }
      }
    }
  }
}
```

`agentId` defaults to `main`; `agentName` is optional. `frozenContext` defaults to
false for existing base-prompt-only users. No conversation-access hook grant is
needed. After initial enrollment, `promptUrl` enables daily shared-prompt refresh
and overdue startup catch-up. Startup never rebuilds local context or patches the
adapter. The optional model-catalog service can also refresh metadata.

`promptUrl` requires `frozenContext`. Use `channel=dev` for Bill and `channel=prod`
for approved fleet deployments. The URL must use HTTPS without embedded credentials
or a fragment. Sync fetches without authentication, refuses redirects, and checks
plain-text content, a 256 KiB limit, UTF-8, and the endpoint's SHA-256
`X-Prompt-Revision` header, with a ten-second request timeout. These integrity
checks are not a signature; the configured HTTPS publisher controls the policy.

The remote text replaces the bundled Codex contract; a short developer-layer
pointer replaces OpenClaw's generic developer policy instead of retaining the old
`prompts/developer.md` policy copy. The frozen local context is still appended.
No local documents are sent to the Worker. The installed snapshot is the local
last-known-good copy: a failed fetch aborts sync before writes, never silently
falls back to a bundled prompt, and does not disrupt normal turns. Status shows
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
With `promptUrl`, the daily service fetches the configured Worker channel and
replaces only the shared prompt prefix when its content changes. The existing
frozen context is preserved byte-for-byte, without rereading workspace files.
Editing a source document or restarting does not rebuild that local snapshot.
Skill bodies remain files the model reads when triggered; their contents are not
frozen. The catalog and its selection are frozen.

**After sync, drain work, restart the Gateway/managed app-server, and use new
conversations.** Existing native threads may retain earlier base instructions.
The plugin never interrupts or resets sessions. Capture an actual request after
provisioning or upgrades; `status` is disk evidence, not live adoption.

The patched assembly boundary validates enrollment, pointer and compiled prompt
hash before replacing/suppressing context. Invalid state aborts assembly.
This guard does not attest to an old thread's retained prompt or detect every
possible higher-priority Codex config override. An upgrade replacing the adapter
removes the guard; startup status is diagnostic, not a global inference gate.
Restore before upgrading, then revalidate compatibility before reenrollment.

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

The plugin preserves upstream model fields and sets only
`model_messages.multi_agent.mode.explicit` to an empty string on each model. It
writes `unblock-codex-models.json` in the managed Codex home and sets the top-level
`model_catalog_json` pointer. It refuses to overwrite another owner's pointer.
Manual edits to this generated catalog are intentionally replaced on refresh.

While the Gateway is running, the service refreshes every 24 hours and catches
up if overdue on startup. Failures retain the installed catalog and retry hourly;
there is no fallback to stale cached metadata. Stopping the service cancels its
timer and waits for an in-flight refresh. Status exposes last/next refresh times
and verifies the local catalog hash without fetching. A successful catalog-only
`refresh-catalog` never changes the fleet prompt or local context snapshot. The
daily service and `refresh` also check the shared prompt when `promptUrl` is set.

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
npm run release:check -- v0.1.1
```

Tests cover compilation, explicit refresh, native/private-body exclusion,
target/disabled/restored behavior, cron/default preservation, malformed state,
pointer ownership and foreign edits. See [VALIDATION.md](VALIDATION.md) for live
proof and limits.

Install with
the packed archive above for an unreleased candidate. After publication, use
`openclaw plugins install npm:@unblocklabs/unblock-codex-prompt@0.1.1 --accept-capabilities`.
The existing [GitHub Release workflow](RELEASING.md) publishes npm only when a
GitHub Release is published. Normal pushes do not release the package.

References: [Codex configuration](https://developers.openai.com/codex/config-reference),
[OpenClaw Codex hook boundaries](https://docs.openclaw.ai/plugins/codex-harness-runtime/hooks).
