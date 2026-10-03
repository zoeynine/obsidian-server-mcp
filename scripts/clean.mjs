import { rm } from "node:fs/promises";

const target = process.argv[2];
const directories =
  target === "build"
    ? ["dist"]
    : target === "test"
      ? [".test-dist"]
      : target === "all"
        ? ["dist", ".test-dist"]
        : undefined;

if (directories === undefined) {
  console.error("Usage: node scripts/clean.mjs <build|test|all>");
  process.exitCode = 1;
} else {
  await Promise.all(
    directories.map((directory) =>
      rm(new URL(`../${directory}`, import.meta.url), {
        force: true,
        recursive: true,
      }),
    ),
  );
}

