# Validation — 2026-09-10

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
