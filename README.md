# Unblock Codex Prompt

A small, explicit prompt-management bridge for dedicated OpenClaw Mac agents.
**Version 0.4.0.** The bridge supports OpenClaw/Codex 2026.10.5 and newer
stable releases with a reviewed context-assembly layout, and agents running
through the Claude CLI backend on reviewed OpenClaw core layouts (2026.10.6–2026.10.9).
See [Claude CLI agents](#claude-cli-agents).

## What you control

- Required `promptUrl`: the shared policy compiled from Fleet Prompt's dev/prod
  sections and served by Cloudflare. It is the only shared-policy source; the plugin
  selects the artifact per runtime (Codex: as configured; Claude: `runtime=claude`).
- Each agent's memory reference (not memory bodies).

**Identity and workspace files are live.** `SOUL.md`, `IDENTITY.md`, `USER.md`
(shared and the session's selected personal file) and `AGENTS.md` are never
snapshotted. OpenClaw loads them every turn, so an edit by you or by the agent
applies to the next turn without a sync. The `MEMORY.md` body stays out of the
prompt; a memory reference points to it.

**The OpenClaw skills catalog is live on both runtimes.** Each runtime receives the
session's catalog from OpenClaw's own session skills snapshot, exactly as OpenClaw
renders it; the plugin never compiles or freezes a copy. Codex gets it in the thread
developer instructions (see below); Claude gets it through OpenClaw's native
`openclaw-skills` mount, or the live session skills prompt when no mount exists.

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
identifiers, date/timezone and user messages. Reviewed duplicate OpenClaw prose is
normalized; unknown `extraSystemPrompt` additions, including incognito context, survive. This is not total
prompt ownership; other plugins/hooks can still add instructions.

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
replaces **only OpenClaw's generic operating policy** with the fleet policy for Claude.
Identity and workspace files stay live through OpenClaw's own project context. Claude Code's native system prompt and prefix,
`CLAUDE.md`, independently installed Claude skills/plugins, tool schemas,
permissions and authentication are untouched. Other agents, other CLI backends and
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

OpenClaw renders the Claude CLI appended system prompt in core, not in a separate
package. Two reviewed functions are patched with exact-byte backups, fingerprinted by
function body (identical in 2026.10.6 and 2026.10.9) and located by following the
assembly's own imports:

- `buildCliAgentSystemPrompt` scopes management to the target agent and the
  host-generated `claude-cli/<model>` model display, then passes the hash-verified
  snapshot down. Tampered or invalid enrolled state aborts the run.
- `buildAgentSystemPrompt` reuses OpenClaw's own builders for the retained mechanics
  and context, and omits the generic policy sections. Downstream Claude MCP
  tool-naming guidance, registered text transforms and the model identity line
  still apply.

| Context or mechanic | Claude CLI treatment |
|---|---|
| Fleet operating policy | The Claude policy (`runtime=claude`), once; never the Codex policy |
| SOUL / IDENTITY / shared USER / selected personal USER | Live host project context, with host persona and precedence wording |
| MEMORY body, generic memory recall section | Omitted; managed memory reference retained |
| AGENTS / TOOLS / HEARTBEAT / BOOTSTRAP and other eligible files | Live host-selected context, routing and truncation; bootstrap notices |
| Unknown `extraSystemPrompt`, including incognito restrictions | Kept, with the reviewed duplicate-prose normalization |
| Output directives, messaging/delivery mechanics, channel message-tool hints | Kept (OpenClaw's builders) |
| Authorized senders, exec-approval protocol, sandbox/elevated facts, TTS, reactions, Control UI embeds, collapsible details | Kept |
| Directory roles, temporal facts, Runtime section, git co-author guidance | Kept |
| Runtime-context block protocol | Short plugin-owned mechanics note |
| Identity line, tooling list, tool-call style, execution bias, Care, OpenClaw Control, delegation/orchestration, docs, model aliases, UI presentation, side chat, silent-reply section | Replaced by the fleet policy |
| OpenClaw's generated `openclaw-skills` Claude plugin | Kept |
| Live session skills catalog (only when OpenClaw mounts no native plugin) | Kept |

**Skills are live on both runtimes.** Both take the catalog from OpenClaw's session
skills snapshot, so skill selection follows OpenClaw's session/refresh lifecycle on
each: Codex in its thread developer instructions, Claude through OpenClaw's native
skills mount or the live session skills prompt.

**Identity files are live on both runtimes, and so is the session's selected
personal USER.md.** Unlike upstream OpenClaw, which keeps persona and personal files
away from subagents, native Codex children inherit them with the thread developer
instructions. Claude Code's native subagents do not receive the appended system
prompt at all (verified on Claude Code 2.1.316), so they see neither the fleet policy
nor persona. On Codex, editing a persona file or changing the skills catalog during a
live incognito conversation changes its thread instructions, which Codex refuses for
incognito threads: that thread's next turn fails. Start a new incognito conversation
after such a change.

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
runtime is not re-enrolled from them. If restore was interrupted and this plugin's
patched bytes are still installed for a runtime that is no longer configured, sync
refuses until `openclaw codex-prompt restore` completes.

Both adapters share one rule for a receipt. It is cleared once every recorded file is
back at its original bytes (a completed restore), or once nothing of the plugin's is
left: every changed file is gone (an update renamed it, or the install directory was
deleted) or the recorded install version was replaced. A sync after that starts fresh,
may target a different OpenClaw installation or Codex package, and replaces the old
receipt's backups. Otherwise sync keeps refusing foreign edits and foreign backups.

Codex `appServer` settings (agent-scoped local stdio only) are checked by sync when
it selects Codex and reported by status as `codexConfigError` for a Codex
enrollment. They never block Claude-only enrollment, status or restore.

Claude CLI enrollment requires the conversation-access grant for the
final-adoption gate:

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
as `claudePolicy` (`text`, `url`, `revision`, `checkedAt`) and `agentContext`. The managed
Claude prompt is `claudePolicy.text`, a blank line, then `agentContext`, read from the
receipt only; the generated file is still verified against the receipt's `promptSha256`.
The receipt is the trust root for Claude: anyone who can write it can set the policy, as
with the file. The final-adoption gate compares the rendered prompt with what the
receipt currently yields, so an edit to `claudePolicy` after assembly blocks the run and
an invalid or missing `claudePolicy` fails closed with a "run codex-prompt sync" error.

**Activation:** drain the target agent's work and restart the Gateway to load the
patched core (and to register the gate after adding the grant). From sync until that
restart, the running Gateway still holds unpatched core, so the gate blocks the
target agent's enrolled Claude runs. The next Claude CLI
process receives the managed prompt. Later policy refreshes change the prompt hash
that OpenClaw keys live Claude processes on, so the conversation's next turn starts a
new process with the new revision and resumes the conversation; its earlier history
is not cleaned. Validate each policy revision in a fresh native conversation.

### Final-adoption gate

A `before_agent_run` gate, registered only with the grant above, checks enrolled
Claude runs for the target agent. If the grant is removed after enrollment, the gate is
not registered and those runs are not checked; startup logs this as an error. The CLI runner's gate context has no runtime
identity, so an observe-only `before_prompt_build` hook marks runs whose preparation
context reports `claude-cli`; it never changes the prompt. Keep `allowPromptInjection`
unset or true. Model fallback reuses the run ID, so each preparation replaces the
mark and a gate context naming a non-Claude provider is never checked as Claude: a
Claude attempt that fails before execution cannot block its fallback. It blocks the run when the final system prompt
lacks the verified managed policy, still contains OpenClaw's generic policy, or the
managed state is invalid. This covers a lost assembly patch, a later prompt-hook
replacement and an incompatible registered text transform. Never-enrolled or
restored agents pass and are reported once with a sync suggestion. Prompt and
history text are compared, never logged. It is a prompt-management guarantee
while the plugin is enabled, not a security boundary.

Known limitation: a run is marked as Claude only when OpenClaw's prompt-build hooks
run. If OpenClaw cannot prepare those hooks (for example, history holding a value its
hook isolation cannot copy), the run is not marked and the gate does not check it. The
assembly patch still manages the prompt; only this extra check is skipped. The gate
does not block unmarked runs, because at that point nothing reliably tells a Claude
run from another CLI backend.

### OpenClaw updates and core integrity

OpenClaw core ships `dist/postinstall-content-inventory.json`, which its update,
triage and settlement paths compare against installed files. A patched core does
not match it. Status reports `coreIntegrity` and distinguishes `patched`,
`partial` (an interrupted restore), `original`, `missing` and `changed` core files. The plugin never edits vendor
inventories.

1. `openclaw codex-prompt restore`, then confirm status reports `original`.
2. Update OpenClaw.
3. Review the new layout. Sync refuses an unreviewed assembly function.
4. `openclaw codex-prompt sync`, then restart the Gateway.

If an update already replaced the patched chunks, restore leaves the updater's
files alone (they are superseded) and restores any chunk still holding the plugin's
bytes; enrolled Claude runs are blocked until re-sync. If OpenClaw was reinstalled in
another directory and the old one deleted, the old receipt is superseded and sync
targets the new installation directly. Prove update and rollback behavior on a disposable installation; inventory
checks alone do not show which update paths fail.

To review a layout without touching the Gateway's installation:

```sh
npm run build
node scripts/validate-claude-layout.mjs /path/to/disposable/node_modules/openclaw
```

It patches that copy, renders managed and upstream prompts through the real
assembly, restores, and checks restored bytes against the vendor inventory.

## Install and enroll

```sh
npm ci
npm run preflight
npm pack
openclaw plugins install ./unblocklabs-unblock-codex-prompt-0.4.0.tgz --force --accept-capabilities
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
Codex-only enrollment needs no conversation-access hook grant; Claude CLI
enrollment requires one (see [Claude CLI agents](#claude-cli-agents)). Initial enrollment enables daily shared-prompt refresh
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

Restore recovers exact original adapter bytes (Codex package and OpenClaw core),
deactivates enrollment and restores the previous TOML pointer. It plans each adapter
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
`appServer` settings to be supported. Restart and use fresh conversations to activate it.
Restore **before** disabling/uninstalling or changing target agents. Disabling
without restoring leaves the managed base but re-enables OpenClaw's generic injections.

### Rolling back to 0.3.x

1. With 0.4 still installed, run `openclaw codex-prompt restore`. A restored enrollment
   is saved in the state format 0.3 reads.
2. Restart the Gateway so the restored OpenClaw core and Codex package are loaded.
3. Install the 0.3.x plugin, then run its `sync` if you want it to manage the agent again.

0.3.x cannot manage Claude CLI agents. Any enrollment that includes Codex, with or
without Claude, and any restored enrollment are saved in the format 0.3.x reads. If the
plugin is rolled back without restoring first, the 0.4 patches find the older runtime
and fall back instead of failing turns: 0.3.x keeps managing Codex, which reads the
policy from its base file, and Claude renders OpenClaw's normal prompt. An active
Claude-only enrollment is refused by 0.3.x; install 0.4 again and restore. 0.3.x
rewrites the state without the Claude runtime when it syncs or restores, and does not
restore OpenClaw core: after returning to 0.4, run restore (or sync) before relying on
Claude runs. A 0.4 snapshot uses a heading 0.3.x's daily refresh does not recognize, so
after rolling back, run 0.3.x's `sync` once to rebuild it. That sync reinstalls 0.3.x's
Codex patch and its frozen skills catalog; drain and restart after it, as after any
sync. Until then the 0.4 patch keeps relaying the live catalog (the relay is inline in
the patch, so it does not depend on the plugin runtime).

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
- The fleet policy replaces OpenClaw's generic policy, so upstream base-policy
  improvements are not inherited. Review upgrades.
- Never commit customer snapshots, raw captures, credentials or host backups.

## Development and release

```sh
npm run preflight
npm run release:check -- v0.4.0
```

Tests cover compilation, explicit refresh, native/private-body exclusion,
target/disabled/restored behavior, cron/default preservation, malformed state,
pointer ownership and foreign edits. See [VALIDATION.md](VALIDATION.md) for live
proof and limits.

Install with
the packed archive above for an unreleased candidate. After publication, use
`openclaw plugins install npm:@unblocklabs/unblock-codex-prompt@0.4.0 --accept-capabilities`.
The existing [GitHub Release workflow](RELEASING.md) publishes npm only when a
GitHub Release is published. Normal pushes do not release the package.

References: [Codex configuration](https://developers.openai.com/codex/config-reference),
[OpenClaw Codex hook boundaries](https://docs.openclaw.ai/plugins/codex-harness-runtime/hooks).
