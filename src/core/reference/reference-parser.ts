import { Worker } from "node:worker_threads";
import { ReferenceQueryError, type ParsedReferences } from "./types.js";
let active = 0;

/** One sequential, killable parser per invocation; no long-lived Vault index. */
export class ReferenceParser {
  readonly #worker: Worker;
  readonly #ready: Promise<void>;
  #closed = false;
  #failed = false;
  constructor() {
    if (active >= 4) throw new ReferenceQueryError("busy", "parser_workers");
    this.#worker = new Worker(new URL("./reference-worker.js", import.meta.url), {
      stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    active++;
    this.#worker.on("error", () => { this.#failed = true; });
    this.#worker.on("exit", () => { this.#failed = true; });
    this.#ready = this.#receive(10_000).then(() => {});
    void this.#ready.catch(() => {});
  }
  #receive(milliseconds: number): Promise<{ result?: ParsedReferences; error?: string }> {
    return new Promise((resolve, reject) => {
      const finish = (message?: { result?: ParsedReferences; error?: string }, error?: ReferenceQueryError): void => {
        clearTimeout(timer);
        this.#worker.off("message", messageHandler);
        this.#worker.off("error", failure);
        this.#worker.off("exit", failure);
        if (error) { this.#failed = true; reject(error); } else resolve(message!);
      };
      const messageHandler = (value: { result?: ParsedReferences; error?: string }): void => finish(value);
      const failure = (): void => finish(undefined, new ReferenceQueryError("parse_failed", "worker"));
      const timer = setTimeout(() => finish(undefined, new ReferenceQueryError("parse_limit", "timeout")), milliseconds);
      this.#worker.once("message", messageHandler);
      this.#worker.once("error", failure);
      this.#worker.once("exit", failure);
    });
  }
  async parse(source: string, targets = false): Promise<ParsedReferences> {
    await this.#ready;
    if (this.#failed || this.#closed) throw new ReferenceQueryError("parse_failed", "worker");
    const response = this.#receive(2_000);
    this.#worker.postMessage({ source, targets });
    const message = await response;
    if (message.error || !message.result) throw new ReferenceQueryError(message.error === "parse_limit" ? "parse_limit" : "parse_failed", "syntax");
    return message.result;
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.#worker.terminate(); } finally { active--; }
  }
}
