import type { CallToolResult } from "@modelcontextprotocol/server";
import { HELP_TOPICS } from "./help-content.generated.js";

const textAliases = new Map([
  ["vault_list_text", "vault_list"],
  ["vault_read_text", "vault_read"],
  ["vault_get_document_map_text", "vault_get_document_map"],
  ["search_query_text", "search_query"],
]);

export interface ObsidianHelpOptions {
  /** Names registered by this server; documentation lookup does not enable tools. */
  readonly toolNames?: readonly string[];
  readonly textProfile?: boolean;
  readonly legacyTextRead?: boolean;
}

function availableTools(options: ObsidianHelpOptions): readonly string[] {
  return options.toolNames ?? HELP_TOPICS.filter(entry => entry.kind === "tool")
    .map(entry => options.textProfile ? withTextToolNames(entry.topic) : entry.topic)
    .concat(options.legacyTextRead && !options.textProfile ? ["vault_read_text"] : []);
}

function helpIndex(options: ObsidianHelpOptions): string {
  const guides = HELP_TOPICS.filter(entry => entry.kind === "guide");
  return "Help topics (pass topic):\nGuides:\n" +
    guides.map(entry => `${entry.topic}: ${entry.title}`).join("\n") +
    "\nTools:\n" + [...new Set(availableTools(options))].sort().join("\n");
}

function availabilityNote(topic: string, options: ObsidianHelpOptions): string {
  const tools = availableTools(options);
  if (tools.includes(topic)) return "";
  const counterpart = textAliases.get(topic) ?? [...textAliases].find(([, canonical]) => canonical === topic)?.[0];
  const alternative = counterpart && tools.includes(counterpart) ? ` Available counterpart: \`${counterpart}\`.` : "";
  return "This tool is documented but is not registered on this endpoint." + alternative + "\n\n";
}

class UnknownHelpTopicError extends Error {}

/** Static manual lookup: no Vault dependency or runtime file/network access. */
export function readObsidianHelp(topic?: string, options: ObsidianHelpOptions = {}): { text: string } {
  if (topic === undefined) return { text: helpIndex(options) };
  const canonical = textAliases.get(topic) ?? topic;
  const entry = HELP_TOPICS.find(candidate => candidate.topic === canonical);
  if (!entry) throw new UnknownHelpTopicError();
  let text: string = options.textProfile ? withTextToolNames(entry.text) : entry.text;
  if (entry.kind === "guide") return { text };
  const alias = textAliases.has(topic) || (options.textProfile === true && [...textAliases.values()].includes(canonical));
  if (alias && !options.textProfile) text = text.replace(/^## \S+/u, "## " + topic);
  return { text: availabilityNote(topic, options) + text + "\n\n### Presentation\n\n" + presentation(canonical, alias, options) };
}

export function mapObsidianHelpError(error: unknown, options: ObsidianHelpOptions = {}): CallToolResult {
  const payload = { error: error instanceof UnknownHelpTopicError
    ? { code: "obsidian_help.unknown_topic", message: "Unknown topic. " + helpIndex(options) }
    : { code: "obsidian_help.internal_error", message: "Help lookup failed unexpectedly" } };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

function presentation(canonical: string, alias: boolean, options: ObsidianHelpOptions): string {
  const shared = alias
    ? `The input schema, core behavior, limits, error codes and exact-byte versions are shared with the standard counterpart \`${canonical}\`. Only result presentation differs.\n\n`
    : "";
  if (canonical === "vault_read" && alias) {
    if (options.legacyTextRead && !options.textProfile) return shared +
      "This standard endpoint enables the legacy text-read option: the entire successful reading is compact JSON in one text block, including content/result. It has no outputSchema or structuredContent.\n\n" +
      "A text-profile endpoint instead uses the two-block reading presentation described below.\n\n" + textReadPresentation;
    return shared + textReadPresentation + "\n\n" +
      "A standard endpoint with the legacy enableTextRead option returns the whole reading as single-block JSON instead. Check the endpoint's tool description for that presentation.";
  }
  if (canonical === "vault_read_binary") return options.textProfile
    ? "Metadata is compact JSON in the first text block; the native image, embedded resource or resource link follows unchanged. There is no outputSchema or structuredContent. Attachment bytes are never serialized into the metadata."
    : "Metadata appears in structuredContent; the attachment appears once in native MCP content (image, embedded resource or resource link). Metadata does not duplicate attachment bytes.";
  return shared + (alias || options.textProfile
    ? "Successful data is compact JSON in one text block, with no outputSchema or structuredContent; successful output is still validated internally. Business errors keep isError: true and one JSON text block with the unchanged error code."
    : "Successful data appears once in structuredContent, with empty content. Business errors use isError: true and one JSON text block; they omit structuredContent.");
}

const textReadPresentation = [
  'In the text profile, whole-file reads return two text blocks: metadata JSON with textField: "content", then the original content string.',
  'Heading/block reads use textField: "result", then the unchanged semantic reader text.',
  "Frontmatter targets retain single-block {path,version,result} JSON for every value type, including strings.",
  "Empty bodies retain the second block. There is no trimming, escaping, newline conversion or code fence.",
  "No outputSchema or structuredContent is exposed; successful output is still validated internally.",
  "Core heading normalization still applies. Business errors retain isError: true and one JSON text block with unchanged codes.",
].join(" ");

function withTextToolNames(text: string): string {
  // Complete names only: existing aliases and stable dotted error codes survive.
  return text.replace(/\b(?:vault_list|vault_read|vault_get_document_map|search_query)\b(?!\.[A-Za-z0-9_])/gu,
    name => name + "_text");
}
