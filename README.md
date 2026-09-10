# Unblock Codex Prompt

One shared Codex operating contract for your OpenClaw fleet. Install a plugin,
set the agent's name, and update the prompt through normal plugin releases.

The bundled contract is based on Bill's Unblock Labs prompt. Every fleet agent
has a dedicated Mac Mini. Only the opening identity is parameterized.

**Status:** initial development version; not yet published to npm.

## What it does

- Renders `prompts/system.md` into `<agentDir>/codex-home/unblock-codex-prompt.md`.
- Sets that agent's `model_instructions_file` in `codex-home/config.toml`.
- Synchronizes on Gateway service startup and plugin configuration reload.
- Preserves unrelated TOML byte-for-byte by editing the parsed value range.
- Provides read-only status, explicit synchronization, and pointer restoration.

This replaces **Codex's base instructions**, not OpenClaw's developer policy.
It does not use a prompt hook, change tool permissions/auth/models, fetch prompts
over the network, or modify the user's global `~/.codex` configuration.

## Requirements

- OpenClaw **2026.9.2+** and its official Codex harness.
- The harness's managed local stdio transport and `homeScope: "agent"`.
- One target agent per plugin installation, default `main`. Set `agentId` to
  target a different configured agent. Other agents are untouched.

Custom app-server commands/arguments and user-scoped or external transports are
refused: those can bypass the managed home or override the prompt. Native Codex
profiles/project configuration can also supersede settings; disk status is not
proof of the effective prompt. Verify the actual request after provisioning.

## Install and configure

Before the first npm release, build and install a local tarball:

```sh
npm ci
npm run preflight
npm pack
openclaw plugins install ./unblocklabs-unblock-codex-prompt-0.1.0.tgz --accept-capabilities
```

After publication, the install command will be:

```sh
openclaw plugins install npm:@unblocklabs/unblock-codex-prompt --accept-capabilities
```

The plugin runs a local file-managing startup service. Review and accept its
capabilities during installation. Local archives also require confirming the
non-ClawHub source (use `--force` only for a trusted archive).

Include `unblock-codex-prompt` in `plugins.allow` if you use an allowlist. Configure:

```json5
{
  plugins: {
    entries: {
      "unblock-codex-prompt": {
        enabled: true,
        config: { agentName: "Bill" }
      }
    }
  }
}
```

Options:

- `agentName`: optional, single line, 1–100 characters. Omit for “You are an
  OpenClaw agent…” rather than copying identity from another file.
- `agentId`: optional, defaults to `main`.

For an existing custom prompt, review the original, then explicitly enroll:

```sh
openclaw codex-prompt status
openclaw codex-prompt sync --adopt
```

The plugin refuses to take over an existing pointer automatically. With no
existing pointer, enabling it permits initial provisioning. Back up your config
before first installation; the plugin's private enrollment file stores only the
previous pointer, not a full credential-bearing config or original prompt copy.
Leave the original prompt file in place if you need rollback.

## Update and activate

Edit the canonical template in this repository, release a version, and roll that
version out using your normal fleet plugin-update process. Each host renders its
own configured name. Do not hand-edit the generated Markdown: sync replaces it.

```sh
openclaw plugins update unblock-codex-prompt
openclaw codex-prompt sync
openclaw codex-prompt status
```

**File changes do not update an already-running Codex thread.** After syncing,
drain active work, restart the Gateway/managed app-server, and verify with a fresh
conversation. Existing conversations can retain earlier base instructions. This
plugin never resets sessions, interrupts work, or restarts services for you.

The startup service is a convenience, not a pre-inference readiness gate. Initial
enrollment and controlled updates should explicitly sync before activation.
Service errors are reported by OpenClaw; they do not globally block inference.
`status` compares disk contents with this installed template and always reports
`runtimeVerified: false` rather than claiming live adoption.

## Restore or uninstall

```sh
openclaw codex-prompt restore
openclaw codex-prompt status
openclaw plugins uninstall unblock-codex-prompt
```

Restore only changes the prompt pointer back to its pre-enrollment value (or
removes the key if it was absent). It refuses to overwrite a foreign pointer,
pauses automatic management, and retains the generated prompt and enrollment
record. Explicit `sync --adopt` re-enrolls it. Restart and use a fresh conversation
to validate restoration as well.

Uninstalling without restoring deliberately leaves the last generated prompt and
pointer working. Files live outside the package directory, so uninstall does not
break Codex by deleting its prompt. Removing generated files is a separate,
operator-owned cleanup after verifying no config points to them.

## Safety and limitations

- Atomic same-directory file replacement and a per-agent sync lock protect normal
  updates. The plugin rejects symlinked paths, hard-linked files, malformed TOML,
  invalid state, and detected concurrent edits. It does not coordinate with every
  possible external TOML writer or provide a multi-file filesystem transaction.
- If sync crashes, inspect the reported empty lock directory and confirm no sync
  is running before removing it. Re-run explicit sync; rollback information is
  written before changing the prompt pointer.
- A prompt is behavior guidance, not an authorization or security boundary.
- Replacing upstream base instructions means upstream prompt improvements are
  not automatically inherited. Revalidate when upgrading Codex/OpenClaw.
- No raw request captures, credentials, host backups, or conversation histories
  belong in this repository or the published package.

## Development

```sh
npm ci
npm run preflight
npm run release:check -- v0.1.0
```

Tests cover preservation, personalization, idempotence, updates, ownership,
rollback, malformed input, linked files, and side-effect-free registration.
See [RELEASING.md](RELEASING.md) for the release-on-GitHub-Release npm workflow.

References: [Codex configuration](https://developers.openai.com/codex/config-reference),
[OpenClaw Codex hook boundaries](https://docs.openclaw.ai/plugins/codex-harness-runtime/hooks).
