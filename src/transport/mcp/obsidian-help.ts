import type { CallToolResult } from "@modelcontextprotocol/server";
import { HELP_TOPICS } from "./help-content.generated.js";

const index = "Help topics (pass topic):\n" + HELP_TOPICS.map(entry => `${entry.topic}: ${entry.title}`).join("\n");

class UnknownHelpTopicError extends Error {}

/** Static manual lookup: no Vault dependency or runtime file/network access. */
export function readObsidianHelp(topic?: string): { text: string } {
  if (topic === undefined) return { text: index };
  const entry = HELP_TOPICS.find(candidate => candidate.topic === topic);
  if (!entry) throw new UnknownHelpTopicError();
  return { text: entry.text };
}

export function mapObsidianHelpError(error: unknown): CallToolResult {
  const payload = { error: error instanceof UnknownHelpTopicError
    ? { code: "obsidian_help.unknown_topic", message: "Unknown topic. " + index }
    : { code: "obsidian_help.internal_error", message: "Help lookup failed unexpectedly" } };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}
