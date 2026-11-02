# Unblock Codex Prompt

A small, explicit prompt-management bridge for dedicated OpenClaw Mac agents.
**Version 0.5.0.** The bridge supports OpenClaw/Codex 2026.10.5 and newer
stable releases with a reviewed context-assembly layout, and agents running
through the Claude CLI backend, whose whole system prompt it replaces through
OpenClaw's public `before_prompt_build` hook without patching OpenClaw core.
See [Claude CLI agents](#claude-cli-agents).

## What you control

- Required `promptUrl`: the shared policy compiled from Fleet Prompt's dev/prod
  sections and served by Cloudflare. It is the only shared-policy source; the plugin
  selects the artifact per runtime (Codex: as configured; Claude: `runtime=claude`).
- Each agent's memory reference (not memory bodies).

**Identity and workspace files are live.** `SOUL.md`, `IDENTITY.md`, `USER.md`
and `AGENTS.md` are never snapshotted. On Codex OpenClaw loads them every turn
(shared `USER.md` and the session's selected personal file); on Claude CLI the
plugin reads the workspace files every turn. An edit by you or by the agent
applies to the next turn without a sync. The `MEMORY.md` body stays out of the
prompt; a memory reference points to it.

**The OpenClaw skills catalog is live on both runtimes.** Each runtime receives the
session's catalog from OpenClaw's own session skills snapshot, exactly as OpenClaw
renders it; the plugin never compiles or freezes a copy. Codex gets it in the thread
developer instructions (see below); Claude gets it through OpenClaw's native
`openclaw-skills` Claude plugin mount. When OpenClaw mounts no such plugin it lists
skills in its system prompt instead, and that list is dropped with the rest of that prompt.

**The fleet policy is live too.** On Codex the generated file (fleet policy and memory
reference) replaces Codex's native base through `model_instructions_file`.
The patched adapter also sends that same file as each thread's `baseInstructions` when
OpenClaw starts or resumes it. Codex reads base instructions per session, not from
history, and OpenClaw fingerprints these requests, so a refreshed revision resumes an
existing thread on its next turn with the new base: no duplicate copy, nothing in
history, and compaction cannot revert it. If the adapter is ever missing, Codex still
reads the policy from the file. The adapter replaces OpenClaw's generic developer
policy with the live OpenClaw skills catalog and the live persona, in the thread
developer instructions native children inherit, and suppresses the separate memory
contribution. Cron guidance remains in its existing parent-local carrier. The optional
managed model catalog removes native Default-mode prose.

There are no bundled system/developer templates or base-only mode. Downloaded
policy and the memory reference are written only to
`<agentDir>/codex-home/unblock-codex-prompt.md`, outside the plugin directory.
Codex reads that generated file; the plugin package does not retain its own copy
of the downloaded policy.

**Still live and untouched:** native AGENTS.md, native skills, tool schemas and
executor protocol, sandbox/approvals, native collaboration mechanics, routing
identifiers, date/timezone and user messages. On Codex, reviewed duplicate OpenClaw prose is
normalized; unknown `extraSystemPrompt` additions, including incognito context, survive.
On Claude CLI they are dropped (see [What Claude CLI no longer receives](#what-claude-cli-no-longer-receives)).
This is not total prompt ownership; other plugins/hooks can still add instructions.

Customer documents stay on each agent's machine, outside this package. Snapshot
files use private permissions.

## Compatibility

- Codex: **OpenClaw and @openclaw/codex >=2026.10.5**. Every published release from
  2026.10.5 through 2026.10.9 has the identical reviewed context-assembly functions.
  Older layouts (2026.9.x and 2026.10.1–2026.10.4) are refused: 2026.9.x carries
  persona in turn-scoped text native children never see. Nodes on those versions
  stay on plugin 0.3.x until upgraded; restore still works for them. Once the Codex
  update has replaced the 0.3.x-patched bundles (new names), a 0.4 sync starts fresh
  without a restore. Bundle names
  may change; fingerprints of the context-assembly functions must still match.
  Changed assembly is refused pending review, rather than patched blindly.
- Local stdio Codex with an OpenClaw agent-scoped home. Operator-selected
  `appServer.command` and `appServer.args` are supported and left unchanged.
  The launcher must honor OpenClaw's `CODEX_HOME` and must not override the
  managed `model_instructions_file`; status cannot attest to launcher behavior.
- One target agent per installation. Other agents use upstream behavior. Native
  Codex children inherit the fleet policy and live persona.
- Claude CLI: no OpenClaw core layout is reviewed or patched for Claude any more. The
  plugin uses OpenClaw's public `before_prompt_build` hook, whose `systemPrompt`
  result replaces the CLI system prompt, so it works on any OpenClaw version with that
  hook behavior. Verified on **2026.10.6** and **2026.10.9** with
  `scripts/validate-claude-hook.mjs` (see [Verify against an OpenClaw install](#verify-against-an-openclaw-install)).

This bridge uses one private upstream seam, the guarded Codex context carriers,
because public prompt hooks cannot fix the dropped-context path. It no longer depends
on OpenClaw's private skills-catalog builder. The adapter suppresses memory at its
producer and moves two host-rendered contributions out of the parent-only and
refreshable carriers into the thread developer instructions, after the fleet policy:
the session's OpenClaw skills catalog (with OpenClaw's `skills_search`/`skills_read`
hints, exactly as upstream renders it, and nothing when upstream renders nothing), then
the persona (SOUL, IDENTITY, shared USER and the selected personal USER). Those are
rebuilt every turn: a catalog change or persona edit changes them, and Codex re-syncs
the existing thread on its next turn with a policy handoff. They survive compaction
and are inherited by native children. Native AGENTS and operational context remain
live; cron guidance and execution permissions are unchanged. The adapter additionally
removes active-computer context, known Slack participation/style/activation policy,
duplicate progress-card prose and basic Markdown tutorials. It compacts source
delivery to current facts and scopes meaningful exec overrides to OpenClaw Gateway
exec; inherited steady-state defaults are omitted. Unrecognized additions are
preserved, not removed by heading. Changed operational functions require review
before sync.
The installer backs up and tracks every
patched bundle; old single-file receipts remain restorable. Runtime module paths
come from the loader's selected entry, never its temporary execution capture.
It validates private seams and is not a promise of compatibility with unseen layouts.
The skills catalog is OpenClaw's own per-session snapshot, with its eligibility,
allowlist, visibility and size-limit logic; the plugin neither adds nor removes skills.

## Claude CLI agents

For agents whose models run through OpenClaw's `claude-cli` backend, the plugin
replaces **OpenClaw's entire Claude CLI system prompt**, as it does for Codex. It
does this through OpenClaw's public `before_prompt_build` hook and never patches
OpenClaw core. Claude Code's native system prompt and prefix, `CLAUDE.md`,
independently installed Claude skills/plugins, tool schemas, permissions and
authentication are untouched. Other agents, other CLI backends and
control/side-question operations keep upstream behavior.

**Each runtime gets its own fleet policy.** The plugin fetches the configured
`promptUrl` once per enrolled runtime. Codex fetches it exactly as configured, with no
`runtime` parameter (the Worker returns the Codex artifact). Claude fetches it with
`runtime=claude` added (via the URL API, so `channel` and other parameters are kept) and
requires the Worker to confirm it in `X-Prompt-Runtime`. The policy wording lives in
the Fleet Prompt sections, not in this package.

**Deploy order.** Deploy the fleet-prompt Worker with runtime support **before**
enrolling any Claude agent. A Worker without it answers `runtime=claude` with HTTP 400:
sync then writes nothing and tells you to deploy the Worker, and a daily refresh keeps
the installed policy and retries hourly. Codex-only nodes never send `runtime` and do
not depend on the Worker deploy.

### How it works

For a run whose hook context names the `claude-cli` provider and the target agent
(subagent sessions of that agent included), with an active enrollment that includes
Claude CLI, the hook returns `systemPrompt`. OpenClaw uses it in place of the prompt it
built (`prepareCliTurnPromptContext`), then applies registered text transforms and
appends its model identity line. The prompt is, in order, with nothing else added:

1. the Claude fleet policy (`runtime=claude`), never the Codex policy;
2. the memory reference (`## Memory reference`);
3. each of `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`
   and `BOOTSTRAP.md` that exists in the run's workspace and is not empty, under a
   `## <absolute path>` header. The `MEMORY.md` body is never included.

The files are read on every call from the run's workspace (the configured agent
workspace when the run names none), so an edit applies to the next turn. Each file is
cut to OpenClaw's per-file bootstrap cap: the agent's `bootstrapMaxChars`, else
`agents.defaults.bootstrapMaxChars`, else OpenClaw's default of 20000 characters, and at
most 4000 for `USER.md` as in OpenClaw. A cut file keeps its head, with no marker.
Symlinks are followed only within the workspace; a file resolving outside it, a
non-regular file or one over 2 MiB is left out with a warning.

The policy and memory reference come from the sync receipt, verified on every call
(enrollment, prompt-file hash). Invalid or tampered enrolled state is logged as an
error, without prompt text, and that run keeps OpenClaw's own prompt. Other agents,
other providers, and paused or never-enrolled agents are left alone. When the hook
returns nothing, OpenClaw's prompt applies unchanged.

**Skills.** Claude gets the session skills through OpenClaw's native `openclaw-skills`
Claude plugin mount, which is not part of the system prompt and is kept.

**Identity on both runtimes.** Native Codex children inherit persona with the thread
developer instructions. Claude Code's native subagents do not receive the appended
system prompt at all (verified on Claude Code 2.1.316), so they see neither the fleet
policy nor persona. On Codex, editing a persona file or changing the skills catalog
during a live incognito conversation changes its thread instructions, which Codex
refuses for incognito threads: that thread's next turn fails. Start a new incognito
conversation after such a change.

### What Claude CLI no longer receives

Replacing the whole prompt drops everything OpenClaw puts in it for these runs, with no
exception for subagent sessions:

- `extraSystemPrompt` content: incognito restrictions, group-chat and channel prompts,
  and subagent task framing;
- per-person `USER.md` overlays (the session's selected personal file); only the
  workspace `USER.md` is carried;
- OpenClaw's generic sections: identity line, tooling list, tool-call style, execution
  bias, Care, OpenClaw Control, delegation, docs, model aliases, UI presentation, side
  chat and silent replies;
- its mechanics: output directives, messaging and delivery sections, channel hints,
  authorized senders, exec-approval protocol, sandbox and elevated facts, TTS,
  reactions, Control UI embeds, directory roles, the Runtime section, git co-author
  guidance, bootstrap truncation notices, and the system-prompt skills list used when no
  native skills plugin is mounted;
- the Claude backend's tool-name section, which OpenClaw adds before hooks run.

Still delivered: per-turn facts OpenClaw puts in the turn's user context (source
delivery, runtime context blocks, relocated runtime facts), the native skills mount,
`prependSystemContext`/`appendSystemContext` from other plugins' hooks, registered text
transforms and the model identity line. If several plugins return `systemPrompt`, the
highest-priority hook wins.

### Enroll

Sync derives runtimes from the agent's configured models using OpenClaw's public
`api.runtime.modelConfig.resolveModelRuntimePolicy`. Models resolve as OpenClaw resolves
them: the agent's own model replaces the default primary and, unless it lists its own,
the default fallbacks. The agent's own allowed-model map also counts, because the agent
can switch to those models at run time; the Gateway-wide `agents.defaults.models` map
does not.
Legacy `claude-cli/<model>` refs count as Claude CLI. This reads authored policy,
not availability; each turn's actual execution path stays authoritative. Sync adds
components and never removes one; use restore. Configuration changes never
enroll a runtime by themselves.

To drop a runtime, restore, change the agent's model configuration, then sync.
The receipts and backups restore keeps are rollback evidence, so a restored
runtime is not re-enrolled from them. If a restore was interrupted and the Codex
adapter's patched bytes are still installed while Codex is no longer configured, sync
refuses until `openclaw codex-prompt restore` completes. A leftover 0.4 Claude core
patch is instead removed by sync (see [Upgrading from 0.4](#upgrading-from-04-and-openclaw-updates)).

The Codex adapter and the 0.4 Claude core receipt share one rule. A receipt is cleared
once every recorded file is back at its original bytes (a completed restore), or once
nothing of the plugin's is left: every changed file is gone (an update renamed it, or
the install directory was deleted) or the recorded install version was replaced. A
Codex sync after that starts fresh, may target a different Codex package, and replaces
the old receipt's backups. Otherwise sync and restore keep refusing foreign edits and
foreign backups.

Codex `appServer` settings (agent-scoped local stdio only) are checked by sync when
it selects Codex and reported by status as `codexConfigError` for a Codex
enrollment. They never block Claude-only enrollment, status or restore.

Claude CLI enrollment needs the hook to be registrable. OpenClaw registers
`before_prompt_build` for a non-bundled plugin only with
`hooks.allowConversationAccess: true`, and blocks it when `hooks.allowPromptInjection`
is `false` (it defaults to allowed). Sync refuses Claude without both:

```json5
{
  plugins: { entries: { "unblock-codex-prompt": {
    enabled: true,
    hooks: { allowConversationAccess: true },
    config: { agentId: "main", frozenContext: true, promptUrl: "https://fleet-prompt.unblocklabs.ai/prompt?channel=dev" },
  } } },
}
```

```sh
openclaw codex-prompt sync          # add --codex-plugin-dir for a first Codex enrollment
openclaw codex-prompt status
```

A Claude-only agent needs no Codex package, TOML pointer, provider catalog
credentials or Codex skill-config writes. Snapshot files still live under
`<agentDir>/codex-home/`. Its sync never fetches the Codex artifact. Its generated
prompt file holds only the shared agent context
(the `## Memory reference` section), so the file's hash still anchors the
sync receipt; there is no Codex policy prefix to refresh. Adding Codex later (sync) regenerates
the file in the Codex layout.

**Where each policy is stored.** The Codex policy stays the prefix of the generated file
(`model_instructions_file`, also sent as `baseInstructions`). The Claude policy and the
shared agent context are stored in the sync receipt (`.unblock-codex-prompt-bundle.json`)
as `claudePolicy` (`text`, `url`, `revision`, `checkedAt`) and `agentContext`, and read
from the receipt only; the generated file is still verified against the receipt's
`promptSha256`. The receipt is the trust root for Claude: anyone who can write it can set
the policy, as with the file. An invalid or missing `claudePolicy` is reported by status
and leaves Claude runs on OpenClaw's prompt until `sync`.

**Activation.** The hook builds the prompt on every turn, so once the Gateway has
loaded this plugin version the target agent's next Claude turn uses it: no restart
after sync, refresh or a workspace edit. Installing or updating the plugin needs a
Gateway restart to load it; a grant change hot-reloads under OpenClaw's default hybrid
reload mode. A changed prompt changes the hash OpenClaw keys live Claude processes on,
so the conversation's next turn starts a new process that resumes the conversation; its
earlier history is not cleaned. Validate each policy revision in a fresh native
conversation. Status `claude.ready` means enrolled, a valid Claude policy, the hook
grant in place and no leftover 0.4 core patch.

Known limitations: OpenClaw runs prompt-build hooks only after it prepares them; if that
fails (for example, history its hook isolation cannot copy) or its turn-context
preparation fails, OpenClaw logs a warning and that run keeps OpenClaw's prompt. The
plugin cannot see those runs.

### Upgrading from 0.4 and OpenClaw updates

0.4 patched two OpenClaw core functions for Claude and kept a receipt
(`codex-home/.unblock-claude-prompt-adapter.json`) with exact-byte backups. On a node
with that patch still installed, status reports `legacyClaudeCore` with
`leftover: true` and Claude is not ready. `sync` validates the patched files and their
backups before writing anything, restores the original bytes, and reports
`legacyClaudeCoreRestored` with `restartRequired: true`: restart the Gateway to reload
the restored core. `restore` removes a leftover patch too. A same-version foreign edit
to a patched file is refused rather than overwritten; files an OpenClaw update already
replaced are left to the updater.

Updating OpenClaw needs no restore for Claude: there is nothing in core to remove. Run
`openclaw codex-prompt restore` first only while status still shows a leftover 0.4
patch, or for Codex as described below.

### Verify against an OpenClaw install

```sh
npm run build
node scripts/validate-claude-hook.mjs /path/to/node_modules/openclaw [...]
```

With no argument it checks the development dependency (also run by `npm test`). It
loads that OpenClaw's own plugin registrar, hook runner, `resolvePromptBuildHookResult`
and `prepareCliTurnPromptContext`, registers this plugin through them, and checks that
the hook's prompt replaces OpenClaw's, that turn context stays in the user prompt, and
that OpenClaw refuses the hook without the grant. It also asserts on the CLI runner's
source that the hook context carries the provider, agent and workspace, that the hook
result reaches the turn context, and that only finalization follows. It does not run a
Claude CLI process. It uses a temporary state directory and changes nothing installed.

## Install and enroll

```sh
npm ci
npm run preflight
npm pack
openclaw plugins install ./unblocklabs-unblock-codex-prompt-0.5.0.tgz --force --accept-capabilities
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
required; the key keeps its historical name, though identity files are now live.
Legacy `agentName` values remain accepted but are unused; identity comes from the
live agent documents. Existing remote fleet configurations need no changes.
Configurations without a remote URL or with base-only mode are no longer supported.
Codex-only enrollment needs no hook grant; Claude CLI enrollment needs
`hooks.allowConversationAccess: true` with prompt injection not disabled (see [Claude CLI agents](#claude-cli-agents)). Initial enrollment enables daily shared-prompt refresh
and overdue startup catch-up. Startup never rebuilds local context or patches the
adapter. The optional model-catalog service can also refresh metadata.

Use `channel=dev` for Bill and `channel=prod`
for approved fleet deployments. The URL must use HTTPS without embedded credentials
or a fragment. Sync fetches without authentication, refuses redirects, and checks
plain-text content, a 256 KiB limit, UTF-8, and the endpoint's SHA-256
`X-Prompt-Revision` header, with a ten-second request timeout. These integrity
checks are not a signature; the configured HTTPS publisher controls the policy.

The remote text supplies the shared base and replaces OpenClaw's generic developer
policy; the generated file is hash-checked against its sync receipt at every assembly.
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
First sync compiles the memory reference and installs the guarded adapter patch with
a private original-source backup. Later syncs reuse its receipt.

## Refresh and activate

```sh
openclaw codex-prompt sync
openclaw codex-prompt status
```

Only explicit `sync` rebuilds the memory reference and adapter policy.
Sync fetches every enrolled runtime's policy before writing anything; if any fetch
fails, nothing is written. The daily service fetches the configured Worker channel for
each enrolled runtime, then, in one locked write, replaces only the Codex policy prefix
of the generated file and/or `claudePolicy` in the receipt when their content changes;
everything after the Codex prefix is preserved byte-for-byte, and a Claude-only change
leaves the Codex file untouched (same bytes and inode). Identity and workspace files
and the skills catalog need neither: they are read live every turn. The catalog lists
each skill's name, description and location; skill bodies remain files the model reads
when triggered. Editing only a `SKILL.md` body therefore does not change the catalog
(or the Codex thread instructions); the next read of that file sees the edit.

A snapshot written by an earlier version still ends in its frozen skills catalog.
Refresh keeps that tail byte-for-byte until the next `sync` rewrites the file without
it. The earlier adapter suppressed the live catalog, so no thread sees both copies,
and no migration is needed: sync, then restart as below.

**After sync, drain work, restart the Gateway/managed app-server, and use new
conversations.** Sync can change the adapter itself, which a running app-server keeps
until restart. Policy refreshes, identity edits and catalog changes need neither.
Upgrading from a version with a frozen catalog: between this sync and the restart, the
running Gateway still holds the earlier patch, which suppresses the live catalog, while
the new file no longer carries the frozen one, so Codex turns in that window have no
skills catalog. Drain the agent before sync and restart right after it.
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

If an upgrade already removed the old package generation, restore leaves the
replacement files alone and the old receipt is superseded: sync installs the reviewed
adapter against the current inspected official package without editing receipts.
Keep the snapshot and operator-selected launcher intact unless a new snapshot was
requested. A source update still requires idle activation
and fresh-session verification; disk status alone does not prove adoption.

### Daily shared-prompt refresh

No additional setting is needed beyond an enrolled `promptUrl`. The service checks
every 24 hours while the Gateway runs and catches up when overdue on startup.
Use `openclaw codex-prompt refresh` to run the same remote-prompt and enabled
model-catalog refresh immediately, without resnapshotting local context.

Both components are attempted independently: a catalog outage cannot prevent a
prompt update, or vice versa. Within the shared prompt, every enrolled runtime is
fetched first: if any fetch fails or validation fails, neither runtime's policy is
updated; failures retry hourly. Unchanged prompt content is not rewritten. Status
reports each runtime's policy revision and last successful `checkedAt` timestamp:
`remotePrompt` for Codex and `claudePolicy` (`url`, `revision`, `checkedAt`) for Claude;
policy text is never printed. A changed
revision reaches existing conversations on their next turn: Codex resumes the thread
with the new base instructions (`nextCodexTurn`), and Claude starts the next CLI
process with the new prompt, resuming the conversation (`nextClaudeProcess`). Earlier
history is not rewritten. A live Codex incognito conversation cannot be resumed; it
keeps the revision it started with.
The plugin never restarts the Gateway automatically.

Existing remote snapshots migrate their shared/context boundary without rereading
agent files. A node upgraded from 0.3.x keeps its frozen identity copy and old
adapter until its next `sync`, which installs live identity and policy delivery;
until then refreshes still reach only new conversations. Ambiguous or externally modified snapshots are refused rather than
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

Restore recovers exact original adapter bytes (the Codex package, and any 0.4 Claude
patch left in OpenClaw core), deactivates enrollment and restores the previous TOML pointer. It plans each adapter
first, validating its files and the backups it will write; an adapter is restored only
while any recorded file still holds the plugin's bytes. Restore then validates the
pointer and pauses enrollment, and only then removes the Codex catalog and skills
block and restores the adapters, so a refusal changes nothing and no run sees a
half-restored bridge. Missing files, and files with other bytes after the recorded
version changed, are superseded and left to the updater; other changes are refused as
foreign edits. A receipt whose files are restored, superseded or otherwise no longer
hold the plugin's bytes never blocks a restore (its state is reported in the output
and in status). Restore retains backup, receipt and generated files as rollback
evidence; they do not keep a runtime enrolled. It does not require the current Codex
`appServer` settings to be supported. Restart and use fresh conversations to activate it
for Codex. Claude CLI turns use OpenClaw's prompt from the next turn, because the hook
reads the paused enrollment; a restart is needed only when a 0.4 core patch was removed.
Restore **before** disabling/uninstalling or changing target agents. Disabling
without restoring leaves the managed base but re-enables OpenClaw's generic injections.

### Rolling back to 0.4

0.4 manages Claude CLI through its OpenClaw core patch, and its final-adoption gate
blocks enrolled Claude runs whose prompt lacks it. Restore with 0.5 first, install 0.4,
then run its `sync` and restart the Gateway. The Codex adapter and the state format are
unchanged between 0.4 and 0.5.

### Rolling back to 0.3.x

1. With 0.5 still installed, run `openclaw codex-prompt restore`. A restored enrollment
   is saved in the state format 0.3 reads.
2. Restart the Gateway so the restored OpenClaw core and Codex package are loaded.
3. Install the 0.3.x plugin, then run its `sync` if you want it to manage the agent again.

0.3.x cannot manage Claude CLI agents. Any enrollment that includes Codex, with or
without Claude, and any restored enrollment are saved in the format 0.3.x reads. If the
plugin is rolled back without restoring first, the Codex patch finds the older runtime
and falls back instead of failing turns: 0.3.x keeps managing Codex, which reads the
policy from its base file, and Claude renders OpenClaw's normal prompt (0.3.x registers
no Claude hook). An active Claude-only enrollment is refused by 0.3.x; install 0.5 again
and restore. 0.3.x rewrites the state without the Claude runtime when it syncs or
restores. A 0.4 or 0.5 snapshot uses a heading 0.3.x's daily refresh does not recognize, so
after rolling back, run 0.3.x's `sync` once to rebuild it. That sync reinstalls 0.3.x's
Codex patch and its frozen skills catalog; drain and restart after it, as after any
sync. Until then the current Codex patch keeps relaying the live catalog (the relay is
inline in the patch, so it does not depend on the plugin runtime).

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
- The fleet policy replaces OpenClaw's generic policy (on Claude CLI, OpenClaw's whole
  system prompt), so upstream base-policy improvements are not inherited. Review upgrades.
- Never commit customer snapshots, raw captures, credentials or host backups.

## Development and release

```sh
npm run preflight
npm run release:check -- v0.5.0
```

Tests cover compilation, explicit refresh, native/private-body exclusion,
target/disabled/restored behavior, cron/default preservation, malformed state,
pointer ownership and foreign edits. See [VALIDATION.md](VALIDATION.md) for live
proof and limits.

Install with
the packed archive above for an unreleased candidate. After publication, use
`openclaw plugins install npm:@unblocklabs/unblock-codex-prompt@0.5.0 --accept-capabilities`.
The existing [GitHub Release workflow](RELEASING.md) publishes npm only when a
GitHub Release is published. Normal pushes do not release the package.

References: [Codex configuration](https://developers.openai.com/codex/config-reference),
[OpenClaw Codex hook boundaries](https://docs.openclaw.ai/plugins/codex-harness-runtime/hooks).
