// Reviewed context-assembly functions from the published 2026.9.2 and 2026.9.4 bundles.
export const legacy = `function buildTurnScopedCollaborationInstructions(params, options = {}) {
\tconst contextInstructions = joinPresentSections(options.turnScopedDeveloperInstructions, options.memoryCollaborationInstructions, options.skillsCollaborationInstructions);
\tif (params.trigger === "cron") return joinPresentSections(buildCronCollaborationInstructions(), contextInstructions);
\tif (contextInstructions?.trim()) return joinPresentSections(buildDefaultCollaborationInstructions(), contextInstructions);
\treturn null;
}`;

export const modern = `function buildCodexParentLocalInstructions(params, options = {}) {
\tconst contextInstructions = joinPresentSections(options.turnScopedDeveloperInstructions, options.memoryCollaborationInstructions, options.skillsCollaborationInstructions);
\tif (params.trigger === "cron") return joinPresentSections(buildCronCollaborationInstructions(), contextInstructions);
\treturn contextInstructions || null;
}
function buildTurnScopedCollaborationInstructions(params, options) {
\tconst instructions = buildCodexParentLocalInstructions(params, options);
\treturn instructions && params.trigger !== "cron" ? joinPresentSections(buildDefaultCollaborationInstructions(), instructions) : instructions;
}`;

// Reviewed parent-local and thread skills carriers from @openclaw/codex@2026.9.8.
export const splitContext = modern.replace(
  "options.turnScopedDeveloperInstructions, options.memoryCollaborationInstructions, options.skillsCollaborationInstructions",
  "options.turnScopedDeveloperInstructions, options.skillsInstructions, options.memoryCollaborationInstructions",
);

export const threadConfiguration = `function buildCodexThreadConfiguration(params, options) {
\treturn {
\t\t...options.cwd !== void 0 ? { cwd: options.cwd } : {},
\t\t...options.appServer.sessionRoot ? { runtimeWorkspaceRoots: [options.appServer.sessionRoot] } : {},
\t\tapprovalPolicy: options.appServer.approvalPolicy,
\t\tapprovalsReviewer: resolveCodexThreadApprovalsReviewer(options.appServer, options.config),
\t\t...codexThreadSandboxOrPermissions(options.appServer),
\t\t...options.appServer.serviceTier !== void 0 ? { serviceTier: options.appServer.serviceTier } : {},
\t\tconfig: buildCodexRuntimeThreadConfigForRun(params, options.config, {
\t\t\t...options,
\t\t\tdirectOnlyToolNamespaces: resolveDirectOnlyToolNamespaces(options.dynamicTools)
\t\t}),
\t\tdeveloperInstructions: joinPresentSections(options.developerInstructions ?? buildDeveloperInstructions(params, { dynamicTools: options.dynamicTools }), options.skillsInstructions)
\t};
}`;

export const legacyThreadConfiguration = threadConfiguration.replace(
  `\t\t\t...options,
\t\t\tdirectOnlyToolNamespaces: resolveDirectOnlyToolNamespaces(options.dynamicTools)`,
  `\t\t\tnativeCodeModeEnabled: options.nativeCodeModeEnabled,
\t\t\tnativeProviderWebSearchSupport: options.nativeProviderWebSearchSupport,
\t\t\tnativeCodeModeOnlyEnabled: options.nativeCodeModeOnlyEnabled,
\t\t\tdirectOnlyToolNamespaces: resolveDirectOnlyToolNamespaces(options.dynamicTools),
\t\t\twebSearchAllowed: options.webSearchAllowed,
\t\t\tappServer: options.appServer,
\t\t\thostSystemAgentActive: options.hostSystemAgentActive,
\t\t\trestrictedToolSurfaceInheritedMcpServerNames: options.restrictedToolSurfaceInheritedMcpServerNames,
\t\t\tshellEnvironment: options.shellEnvironment,
\t\t\tdisableLoginShell: options.disableLoginShell`,
).replace(
  "joinPresentSections(options.developerInstructions ?? buildDeveloperInstructions(params, { dynamicTools: options.dynamicTools }), options.skillsInstructions)",
  "options.developerInstructions ?? buildDeveloperInstructions(params, { dynamicTools: options.dynamicTools })",
);

export function splitAdapterFixture() {
  const shared = `function joinPresentSections(...sections) { return sections.filter(section => section?.trim()).join("\\n\\n"); }`;
  const lifecycle = adapterFixture(splitContext, "").replace(/function buildDeveloperInstructions[^\n]+\n/u, "");
  return [lifecycle, `function buildDeveloperInstructions(params, options = {}) { return "native policy"; }\n${threadConfiguration}\n${shared}\n`];
}

export function adapterFixture(context, thread = legacyThreadConfiguration) {
  return `function buildDeveloperInstructions(params, options = {}) { return "native policy"; }
${context}
function buildCronCollaborationInstructions() { return "CRON"; }
function buildDefaultCollaborationInstructions() { return "DEFAULT"; }
function joinPresentSections(...sections) { return sections.filter(section => section?.trim()).join("\\n\\n"); }
${thread}
`;
}
