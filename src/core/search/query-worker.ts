import { parentPort, workerData } from "node:worker_threads";
import logic from "json-logic-js";
import glob from "glob-to-regexp";
import { requireJson } from "../document/note-json.js";
import { MAX_SEARCH_QUERY_OUTPUT_BYTES } from "./query-limits.js";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const unavailable = new Set(["links", "backlinks", "unresolvedLinks"]);
let currentNote: unknown;

// Own-property lookup preserves JSON semantics without exposing JS prototypes.
logic.add_operation("var", function (this: unknown, key: unknown, fallback: unknown = null) {
  let value: unknown = this;
  if (key === undefined || key === null || key === "") return value;
  const parts = String(key).split(".");
  if (parts.some((part) => forbidden.has(part))) throw new Error("unsafe_variable");
  if (this === currentNote && unavailable.has(parts[0]!)) throw new Error("unsupported_field");
  for (const part of parts) {
    if (value === null || value === undefined || !Object.hasOwn(Object(value), part)) return fallback;
    value = (Object(value) as Record<string, unknown>)[part];
  }
  return value === undefined ? fallback : value;
});
logic.add_operation("glob", (pattern, field) => typeof pattern === "string" && typeof field === "string" && glob(pattern).test(field));
logic.add_operation("regexp", (pattern, field) => typeof pattern === "string" && typeof field === "string" && new RegExp(pattern).test(field));

parentPort!.on("message", (note: unknown) => {
  try {
    currentNote = note;
    const result = logic.apply(workerData, note);
    // Local REST's result filter is slightly stricter than JsonLogic truthy({}).
    const truthy = result != null && (Array.isArray(result) ? result.length > 0 :
      typeof result === "object" ? Object.keys(result).length > 0 : Boolean(result));
    if (!truthy) { parentPort!.postMessage({ result: null, bytes: 0 }); return; }
    requireJson(result);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes > MAX_SEARCH_QUERY_OUTPUT_BYTES) {
      parentPort!.postMessage({ error: "result_limit", bytes });
      return;
    }
    parentPort!.postMessage({ result, bytes });
  } catch (error) {
    const message = error instanceof Error ? error.message : "evaluation_failed";
    parentPort!.postMessage({ error: ["unsafe_variable", "unsupported_field"].includes(message) ? message : "evaluation_failed" });
  }
});
parentPort!.postMessage({ ready: true });
