import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it("reopens the original agent ID and historical conversation in a second process", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-restart-resume-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const fixture = fileURLToPath(new URL("../fixtures/resume-process.mjs", import.meta.url));
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") };
  try {
    const first = await exec(process.execPath, [fixture, "save", root], { cwd: root, env, timeout: 60000 });
    const second = await exec(process.execPath, [fixture, "restore", root], { cwd: root, env, timeout: 60000 });
    const saved = JSON.parse(first.stdout.trim().split("\n").at(-1)!);
    const restored = JSON.parse(second.stdout.trim().split("\n").at(-1)!);
    expect(restored.pid).not.toBe(saved.pid);
    expect(restored.id).toBe(saved.id);
    expect(restored.result).toBe("restored-history-confirmed");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120000);
