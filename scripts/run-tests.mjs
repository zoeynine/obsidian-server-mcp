import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(filename));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(filename);
  }
  return files.sort();
}

// Explicit discovery avoids shell/Node-version glob differences. Each file gets
// Node's default process isolation; one file at a time bounds fixture resources.
const files = await discover(path.join(root, ".test-dist", "test"));
if (files.length === 0) throw new Error("No compiled tests found; run npm test.");
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
