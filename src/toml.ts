import { parseTOML } from "toml-eslint-parser";

const KEY = "model_instructions_file";

function promptEntry(source: string) {
  let ast;
  try {
    ast = parseTOML(source, { tomlVersion: "1.0" });
  } catch {
    // Parser messages can include source snippets from credential-bearing TOML.
    throw new Error("Invalid Codex TOML; refusing to edit it");
  }
  const entries = ast.body[0].body.filter((node) => node.type === "TOMLKeyValue");
  const keyName = (node: (typeof entries)[number]) => {
    const key = node.key.keys[0];
    return key?.type === "TOMLBare" ? key.name : key?.value;
  };
  if (entries.some((node) => keyName(node) === "experimental_instructions_file")) {
    throw new Error("Migrate experimental_instructions_file before enrolling this agent");
  }
  const entry = entries.find((node) => keyName(node) === KEY);
  if (entry && (entry.key.keys.length !== 1 || entry.value.type !== "TOMLValue" || entry.value.kind !== "string")) {
    throw new Error("model_instructions_file must be a top-level string");
  }
  return entry;
}

export function readPromptPointer(source: string): string | null {
  const value = promptEntry(source)?.value;
  return value?.type === "TOMLValue" && value.kind === "string" ? value.value : null;
}

/** Edit the parsed value's range, not a regex or a reserialized TOML document. */
export function setPromptPointer(source: string, pointer: string | null) {
  const entry = promptEntry(source);
  if (readPromptPointer(source) === pointer) return source;
  let result: string;
  if (entry) {
    const [start, end] = pointer === null ? entry.range : entry.value.range;
    result = source.slice(0, start) + (pointer === null ? "" : JSON.stringify(pointer)) + source.slice(end);
  } else {
    if (pointer === null) return source;
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    result = `${KEY} = ${JSON.stringify(pointer)}${newline}${source}`;
  }
  if (readPromptPointer(result) !== pointer) throw new Error("TOML pointer verification failed");
  return result;
}
