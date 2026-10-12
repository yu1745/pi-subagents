import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bundledExtension from "../bundle/index.js";
import sourceExtension from "../src/index.js";
import { packageJsonPath } from "../src/package-info.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

describe("installed extension bundle", () => {
  let hermetic: Hermetic;
  const boots: ReturnType<typeof makePi>[] = [];

  beforeEach(() => {
    hermetic = hermeticDir();
  });

  afterEach(async () => {
    for (const boot of boots.splice(0)) {
      await boot.lifecycle.get("session_shutdown")?.({ reason: "quit" }, ctx());
    }
    hermetic.restore();
    vi.unstubAllEnvs();
  });

  it("is the package entry and keeps package metadata relative to the package root", () => {
    expect(manifest.pi.extensions).toEqual(["./bundle/index.js"]);
    expect(dirname(packageJsonPath)).toBe(resolve(root));
    expect(JSON.parse(readFileSync(packageJsonPath, "utf8")).name).toBe(manifest.name);
  });

  it.each(["0", "1"])("preserves registrations with the owned-job runtime=%s", async runtime => {
    vi.stubEnv("PI_SUBAGENTS_JOB_RUNTIME", runtime);
    const source = makePi();
    const bundled = makePi();
    boots.push(source, bundled);
    for (const boot of [source, bundled]) boot.pi.registerShortcut = vi.fn();
    sourceExtension(source.pi);
    bundledExtension(bundled.pi);

    expect([...bundled.tools.keys()]).toEqual([...source.tools.keys()]);
    expect([...bundled.commands.keys()]).toEqual([...source.commands.keys()]);
    expect([...bundled.lifecycle.keys()]).toEqual([...source.lifecycle.keys()]);
    expect([...bundled.registeredFlags]).toEqual([...source.registeredFlags]);
    expect([...bundled.entryRenderers.keys()]).toEqual([...source.entryRenderers.keys()]);
    for (const [name, tool] of bundled.tools) {
      expect(tool.description, name).toBe(source.tools.get(name).description);
      expect(tool.parameters, name).toEqual(source.tools.get(name).parameters);
    }

    if (runtime === "1") {
      const context = ctx();
      await bundled.commands.get("bg-version").handler("", context);
      expect(context.ui.notify).toHaveBeenCalledWith(
        `${manifest.name}@${manifest.version} loaded from ${resolve(root)}`,
        "info",
      );
    }
  });
});
