import { Worker } from "node:worker_threads";
import type { JsonValue, NoteJson } from "../document/note-json.js";
import { requireJson } from "../document/note-json.js";
import { InvalidVaultSearchQueryError, VaultSearchQueryBudgetExceededError, MAX_SEARCH_QUERY_AST_NODES, MAX_SEARCH_QUERY_DEPTH,
  MAX_SEARCH_QUERY_SERIALIZED_BYTES, MAX_SEARCH_QUERY_STRING_LENGTH } from "./search-vault-query.js";
import { MAX_SEARCH_QUERY_OUTPUT_BYTES } from "./query-limits.js";

const operators = new Set("== === != !== > >= < <= !! ! % in cat substr + * - / min max merge var missing missing_some if ?: and or map filter reduce all none some glob regexp".split(" "));
const unavailable = new Set(["links", "backlinks", "unresolvedLinks"]);
const MAX_ACTIVE_QUERY_WORKERS = 4;
let activeWorkers = 0;

export function validateQuery(query: unknown): void {
  try { requireJson(query, 4096); } catch { throw new InvalidVaultSearchQueryError("not_json_serializable"); }
  if (Buffer.byteLength(JSON.stringify(query), "utf8") > MAX_SEARCH_QUERY_SERIALIZED_BYTES) throw new InvalidVaultSearchQueryError("query_too_large");
  if (query === null || typeof query !== "object" || Array.isArray(query)) throw new InvalidVaultSearchQueryError("invalid_shape");
  let nodes = 0;
  function walk(value: unknown, depth: number, noteScope = true): void {
    if (depth > MAX_SEARCH_QUERY_DEPTH) throw new InvalidVaultSearchQueryError("ast_depth");
    if (typeof value === "string" && value.length > MAX_SEARCH_QUERY_STRING_LENGTH) throw new InvalidVaultSearchQueryError("string_too_long");
    if (Array.isArray(value)) { for (const child of value) walk(child, depth, noteScope); return; }
    if (value === null || typeof value !== "object") return;
    const keys = Object.keys(value);
    if (keys.length !== 1) return; // Literal object, as in the pinned JsonLogic engine.
    if (++nodes > MAX_SEARCH_QUERY_AST_NODES) throw new InvalidVaultSearchQueryError("ast_nodes");
    const op = keys[0]!;
    if (!operators.has(op)) throw new InvalidVaultSearchQueryError("unsupported_operator");
    const operand = (value as Record<string, unknown>)[op];
    if (op === "var") {
      const key: unknown = Array.isArray(operand) ? operand[0] : operand;
      if (typeof key === "string") {
        const parts = key.split(".");
        if ((noteScope && unavailable.has(parts[0]!)) || parts.some((part) => ["__proto__", "constructor", "prototype"].includes(part))) {
          throw new InvalidVaultSearchQueryError("invalid_var");
        }
      }
    }
    if (["map", "filter", "reduce", "all", "none", "some"].includes(op) && Array.isArray(operand)) {
      operand.forEach((child, index) => walk(child, depth + 1, noteScope && index !== 1));
    } else walk(operand, depth + 1, noteScope);
  }
  walk(query, 1);
}

/** Evaluation is killable: regular expressions and nested collection operators
 * cannot monopolize the MCP event loop. One worker belongs to one invocation. */
export class QueryEvaluator {
  readonly #worker: Worker;
  readonly #ready: Promise<void>;
  #failure: Error | undefined;
  #closed = false;
  constructor(query: unknown) {
    if (activeWorkers >= MAX_ACTIVE_QUERY_WORKERS) throw new InvalidVaultSearchQueryError("evaluation_limit");
    this.#worker = new Worker(new URL("./query-worker.js", import.meta.url), {
      workerData: query, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    activeWorkers++;
    this.#worker.on("error", () => { this.#failure = new InvalidVaultSearchQueryError("evaluation_failed"); });
    this.#worker.on("exit", () => { this.#failure ??= new InvalidVaultSearchQueryError("evaluation_failed"); });
    this.#ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new InvalidVaultSearchQueryError("evaluation_limit")), 10_000);
      const done = (error?: Error): void => {
        clearTimeout(timer);
        this.#worker.off("message", ready);
        this.#worker.off("error", failed);
        this.#worker.off("exit", failed);
        if (error) reject(error); else resolve();
      };
      const ready = (): void => done();
      const failed = (): void => done(new InvalidVaultSearchQueryError("evaluation_failed"));
      this.#worker.once("message", ready);
      this.#worker.once("error", failed);
      this.#worker.once("exit", failed);
    });
    // A scan can fail before its first evaluation. Keep startup rejection handled.
    void this.#ready.catch(() => {});
  }
  async evaluate(note: NoteJson): Promise<{ result: JsonValue; bytes: number }> {
    await this.#ready;
    if (this.#failure) throw this.#failure;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new InvalidVaultSearchQueryError("evaluation_limit")), 2000);
      const finish = (error?: Error, value?: { result: JsonValue; bytes: number }): void => {
        clearTimeout(timeout);
        this.#worker.off("message", onMessage);
        this.#worker.off("error", onError);
        this.#worker.off("exit", onError);
        if (error) { this.#failure = error; reject(error); }
        else resolve(value!);
      };
      const onError = (): void => finish(new InvalidVaultSearchQueryError("evaluation_failed"));
      const onMessage = (message: { result: JsonValue; bytes: number; error?: string }): void => {
        if (message.error === "result_limit") {
          finish(new VaultSearchQueryBudgetExceededError(
            "maxOutputBytes", MAX_SEARCH_QUERY_OUTPUT_BYTES, BigInt(message.bytes),
          ));
        } else if (message.error) finish(new InvalidVaultSearchQueryError(message.error === "unsupported_field" || message.error === "unsafe_variable" ? "invalid_var" : "evaluation_failed"));
        else finish(undefined, message);
      };
      this.#worker.once("message", onMessage);
      this.#worker.once("error", onError);
      this.#worker.once("exit", onError);
      this.#worker.postMessage(note);
    });
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.#worker.terminate(); } finally { activeWorkers--; }
  }
}
