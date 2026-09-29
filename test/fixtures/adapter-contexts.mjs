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

export function adapterFixture(context) {
  return `function buildDeveloperInstructions(params, options = {}) { return "native policy"; }
${context}
function buildCronCollaborationInstructions() { return "CRON"; }
function buildDefaultCollaborationInstructions() { return "DEFAULT"; }
function joinPresentSections(...sections) { return sections.filter(section => section?.trim()).join("\\n\\n"); }
`;
}
