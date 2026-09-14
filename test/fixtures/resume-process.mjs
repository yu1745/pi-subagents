// Two invocations share only files. Real manager + runner + SDK, scripted model, no network.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";

const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const jiti = createJiti(import.meta.url);
const { AgentManager } = await jiti.import("../../src/agent-manager.ts");
const { registerAgents } = await jiti.import("../../src/agent-types.ts");
const { fauxModelBackend } = await jiti.import("../helpers/faux-model-backend.ts");
const [phase, root] = process.argv.slice(2);
const exchange = join(root, "exchange.json");
const saved = phase === "restore" ? JSON.parse(readFileSync(exchange, "utf8")) : undefined;
const parent = saved ? SessionManager.open(saved.parentFile) : SessionManager.create(root, join(root, "sessions"));
if (!saved) {
  parent.appendMessage({ role: "user", content: "parent task", timestamp: Date.now() });
  parent.appendMessage(fauxAssistantMessage("parent checkpoint"));
}
registerAgents(new Map([["durable-test", {
  name: "durable-test", description: "restart fixture", extensions: false, skills: false,
  builtinToolNames: [], systemPrompt: "Remember the conversation.", promptMode: "replace", persistSession: true,
}]]));
const faux = registerFauxProvider({ provider: "resume-faux", models: [{ id: "resume-model" }], tokensPerSecond: 100000 });
const model = faux.getModel();
const backend = fauxModelBackend(model);
const ctx = {
  cwd: root, model, sessionManager: parent,
  modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
  getSystemPrompt: () => "parent prompt", hasUI: false,
};
const exec = promisify(execFile);
const pi = { exec: async (command, args, options) => {
  try { const r = await exec(command, args, options); return { ...r, code: 0, killed: false }; }
  catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: 1, killed: false }; }
} };
const manager = new AgentManager();
manager.configurePersistence(parent.getSessionFile(), parent.getSessionId());
try {
  if (!saved) {
    faux.setResponses([fauxAssistantMessage("historical-answer-741")]);
    const { id, record } = await manager.spawnAndWait(pi, ctx, "durable-test", "secret-history-741", { description: "Original description", name: "remember-me", isolated: true });
    assert.equal(record.status, "completed", record.error);
    assert.equal(record.result, "historical-answer-741");
    writeFileSync(exchange, JSON.stringify({ id, parentFile: parent.getSessionFile(), sessionId: record.resumeState.sessionId, handle: record.handle, alias: record.alias }));
    await manager.dispose();
    console.log(JSON.stringify({ phase, id, pid: process.pid }));
  } else {
    assert.equal(manager.listAgents().length, 0, "restart must not automatically run children");
    const target = manager.resolveMention(saved.id);
    assert.equal(target?.kind, "tombstone");
    assert.equal(target.entry.handle, saved.handle);
    assert.equal(target.entry.alias, saved.alias);
    faux.setResponses([(context) => {
      const history = JSON.stringify(context.messages);
      assert.ok(history.includes("secret-history-741"), "lost prior user message");
      assert.ok(history.includes("historical-answer-741"), "lost prior assistant message");
      return fauxAssistantMessage("restored-history-confirmed");
    }]);
    const { id, record } = await manager.spawnAndWait(pi, ctx, target.entry.type, "continue", { description: "ignored", restore: target.entry });
    assert.equal(id, saved.id);
    assert.equal(record.resumeState.sessionId, saved.sessionId);
    assert.equal(record.result, "restored-history-confirmed", record.error);
    assert.equal(record.description, "Original description");
    await manager.dispose();
    console.log(JSON.stringify({ phase, id, pid: process.pid, result: record.result }));
  }
} finally { await manager.dispose(); faux.unregister(); }
