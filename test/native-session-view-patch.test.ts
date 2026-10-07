import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  class Mode {
    renderer = { mode: "regular" };
    ui = this.renderer;
    isShuttingDown = false;
    createExtensionUIContext() { calls.push("context"); return { theme: {}, custom: () => { calls.push("custom"); } }; }
    resetExtensionUI() { calls.push("reset"); }
    shutdown() { calls.push("shutdown"); return Promise.resolve(); }
    stop() { calls.push("stop"); }
    switchTuiMode() { calls.push("switch"); return true; }
  }
  return { version: "1.0.0", Mode, calls, create: vi.fn(), host: vi.fn() };
});
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  InteractiveMode: mocks.Mode,
  get VERSION() { return mocks.version; },
}));
vi.mock("../src/ui/native-pi-1.0.0/read-only-view.js", () => ({ createReadOnlySessionView: mocks.create }));
vi.mock("../src/ui/native-pi-1.0.0/modal-host.js", () => ({ installModalHost100: mocks.host }));

import {
  getNativeSessionViewUnavailableReason,
  installNativeSessionViewPatch,
  type NativeSessionViewPatch,
} from "../src/ui/native-pi-1.0.0/index.js";

type ViewerUI = ExtensionUIContext & { viewSession(session: AgentSession, options?: { signal?: AbortSignal }): Promise<void> };
const handles: NativeSessionViewPatch[] = [];
const prototype = mocks.Mode.prototype;
const originalContext = prototype.createExtensionUIContext;
const originalStop = prototype.stop;
let endModal: () => void;
let viewDispose: ReturnType<typeof vi.fn>;
let hostDispose: ReturnType<typeof vi.fn>;
let modalClose: ReturnType<typeof vi.fn>;
const session = {} as AgentSession;

function install() {
  const handle = installNativeSessionViewPatch();
  handles.push(handle);
  return handle;
}
function uiFor(mode: InstanceType<typeof mocks.Mode>) {
  return mode.createExtensionUIContext() as unknown as ViewerUI;
}

beforeEach(() => {
  mocks.version = "1.0.0";
  mocks.calls.length = 0;
  mocks.create.mockReset();
  mocks.host.mockReset();
  viewDispose = vi.fn(() => { mocks.calls.push("dispose-view"); });
  hostDispose = vi.fn(() => { mocks.calls.push("dispose-host"); });
  mocks.create.mockImplementation(() => ({ render: () => [], invalidate() {}, dispose: viewDispose }));
  mocks.host.mockImplementation(() => ({
    show: (_component: unknown, onClose: () => void) => {
      let closed = false;
      modalClose = vi.fn(() => {
        if (closed) return;
        closed = true;
        mocks.calls.push("detach");
        onClose();
      });
      endModal = modalClose;
      return { close: modalClose };
    },
    dispose: hostDispose,
  }));
});
afterEach(() => {
  for (const handle of handles.splice(0).reverse()) handle.dispose();
  prototype.stop = originalStop;
});

describe("Pi 1.0.0 native view bridge", () => {
  it("injects a nonprompt API and patches the actual renderer, not the UI facade", async () => {
    expect(install().supported).toBe(true);
    const mode = new mocks.Mode();
    mode.ui = { mode: "facade" };
    const ui = uiFor(mode);
    const done = ui.viewSession(session);
    expect(mocks.host).toHaveBeenCalledWith(mode.renderer);
    expect(mocks.create).toHaveBeenCalledWith(mode, session, ui.theme, expect.any(Function), {});
    expect(mocks.calls).not.toContain("custom");
    endModal();
    await done;
    expect(viewDispose).toHaveBeenCalledOnce();
    expect(hostDispose).toHaveBeenCalledOnce();
    expect(mocks.calls.indexOf("detach")).toBeLessThan(mocks.calls.indexOf("dispose-view"));
  });

  it("uses one wrapper across activations and restores it only after the last release", async () => {
    const first = install();
    const wrapper = prototype.createExtensionUIContext;
    const second = install();
    expect(prototype.createExtensionUIContext).toBe(wrapper);
    const ui = uiFor(new mocks.Mode());
    const done = ui.viewSession(session);
    first.dispose();
    first.dispose();
    expect(prototype.createExtensionUIContext).toBe(wrapper);
    expect(viewDispose).not.toHaveBeenCalled();
    second.dispose();
    await done;
    expect(prototype.createExtensionUIContext).toBe(originalContext);
    expect(viewDispose).toHaveBeenCalledOnce();
    await expect(ui.viewSession(session)).rejects.toThrow("unloaded");
    // Native /reload can reuse the old UI function. It must use the new lease.
    expect(install().supported).toBe(true);
    const reopened = ui.viewSession(session);
    endModal();
    await reopened;
    expect(viewDispose).toHaveBeenCalledTimes(2);
  });

  it("closes before reset, shutdown and stop; reopens after each detach", async () => {
    install();
    const mode = new mocks.Mode();
    const ui = uiFor(mode);
    for (const name of ["resetExtensionUI", "shutdown", "stop"] as const) {
      mocks.calls.length = 0;
      const done = ui.viewSession(session);
      await mode[name]();
      await done;
      const native = name === "resetExtensionUI" ? "reset" : name;
      expect(mocks.calls.indexOf("dispose-view")).toBeLessThan(mocks.calls.indexOf(native));
    }
  });

  it("blocks renderer replacement and concurrent views without altering the existing view", async () => {
    install();
    const mode = new mocks.Mode();
    const ui = uiFor(mode);
    const done = ui.viewSession(session);
    await expect(ui.viewSession(session)).rejects.toThrow("already open");
    const switchMode = mode.switchTuiMode as unknown as (mode: string) => boolean;
    expect(switchMode.call(mode, "fullscreen")).toBe(false);
    expect(switchMode.call(mode, "regular")).toBe(true);
    expect(mocks.calls).not.toContain("switch");
    endModal();
    await done;
    expect(switchMode.call(mode, "fullscreen")).toBe(true);
    expect(mocks.calls).toContain("switch");
  });

  it("uses abort only for presentation and skips already-aborted or shutdown opens", async () => {
    install();
    const mode = new mocks.Mode();
    const ui = uiFor(mode);
    const aborted = new AbortController();
    aborted.abort();
    await ui.viewSession(session, { signal: aborted.signal });
    expect(mocks.create).not.toHaveBeenCalled();
    const live = new AbortController();
    const done = ui.viewSession(session, { signal: live.signal });
    live.abort();
    await done;
    expect(viewDispose).toHaveBeenCalledOnce();
    mode.isShuttingDown = true;
    await expect(ui.viewSession(session)).rejects.toThrow("shutdown");
  });

  it("releases the reservation on creation failure and rejects without leaking host state", async () => {
    install();
    const ui = uiFor(new mocks.Mode());
    mocks.create.mockImplementationOnce(() => { throw new Error("bad snapshot"); });
    await expect(ui.viewSession(session)).rejects.toThrow("bad snapshot");
    expect(hostDispose).toHaveBeenCalledOnce();
    const done = ui.viewSession(session);
    endModal();
    await done;
  });

  it("settles cleanup failures rather than throwing them into native input dispatch", async () => {
    install();
    const ui = uiFor(new mocks.Mode());
    viewDispose.mockImplementation(() => { throw new Error("bad disposal"); });
    const done = ui.viewSession(session);
    const result = expect(done).rejects.toThrow("bad disposal");
    expect(() => endModal()).not.toThrow();
    await result;
    expect(hostDispose).toHaveBeenCalledOnce();
  });

  it("rejects a different Pi version without touching prototypes", () => {
    mocks.version = "1.0.4";
    const handle = install();
    expect(handle.supported).toBe(false);
    expect(handle.reason).toContain("1.0.0");
    expect(handle.reason).toContain("1.0.4");
    expect(prototype.createExtensionUIContext).toBe(originalContext);
    expect(getNativeSessionViewUnavailableReason()).toContain("tightly coupled");
  });

  it("does not clobber another patch during disposal and refuses unsafe stacking", () => {
    const first = install();
    const external = vi.fn();
    prototype.stop = external;
    const second = install();
    expect(second.supported).toBe(false);
    expect(second.reason).toContain("Another extension replaced");
    first.dispose();
    expect(prototype.stop).toBe(external);
  });
});
