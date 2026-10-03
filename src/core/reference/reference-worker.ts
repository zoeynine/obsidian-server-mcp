import { parentPort } from "node:worker_threads";
import { parseReferences } from "./parse-references.js";
import { ReferenceQueryError } from "./types.js";
parentPort!.on("message", ({ source, targets }: { source: string; targets: boolean }) => {
  try { parentPort!.postMessage({ result: parseReferences(source, targets) }); }
  catch (error) { parentPort!.postMessage({ error: error instanceof ReferenceQueryError ? error.code : "parse_failed" }); }
});
parentPort!.postMessage({ ready: true });
