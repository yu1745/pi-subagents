import { fileURLToPath } from "node:url";

// src/, dist/ and the installed bundle/ entry are all one level below the
// package root. Keep import.meta.url here, not in a nested source module:
// bundling changes a nested module's location to that of the bundle.
export const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
