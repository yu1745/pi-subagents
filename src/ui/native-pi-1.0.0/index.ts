/** Runtime-only integration for the exact Pi release named below. Not a public SDK adapter. */
import { type AgentSession, type ExtensionUIContext, InteractiveMode, type Theme, VERSION } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { installModalHost100 } from "./modal-host.js";
import { createReadOnlySessionView, type ReadOnlySessionViewOptions } from "./read-only-view.js";

export const SUPPORTED_PI_VERSION = "1.0.0";
const REGISTRY = Symbol.for("pi-subagents.native-session-view.pi-1.0.0");
const HOOKS = ["createExtensionUIContext", "resetExtensionUI", "shutdown", "stop", "switchTuiMode"] as const;
type HookName = (typeof HOOKS)[number];
type NativeMethod = (this: NativeMode, ...args: unknown[]) => unknown;

interface NativeMode {
  ui: TUI;
  renderer: TUI;
  isShuttingDown?: boolean;
  session: AgentSession;
}
interface ViewOptions extends ReadOnlySessionViewOptions {
  signal?: AbortSignal;
}
interface NativeUI extends ExtensionUIContext {
  getSubagentsMainSession?(): AgentSession;
  viewSession?(session: AgentSession, options?: ViewOptions): Promise<void>;
}
interface InstalledHook {
  name: HookName;
  original: PropertyDescriptor;
  wrapper: NativeMethod;
}
interface Registry {
  owners: Set<symbol>;
  hooks: InstalledHook[];
  views: Map<NativeMode, () => void>;
  open: (state: Registry, mode: NativeMode, session: AgentSession, theme: Theme, options: ViewOptions) => Promise<void>;
}
export interface NativeSessionViewPatch {
  supported: boolean;
  reason?: string;
  /** Releases only this activation; the last owner detaches views and restores owned hooks. */
  dispose(): void;
}

let unavailableReason: string | undefined;

export function getNativeSessionViewUnavailableReason(): string {
  try {
    if (VERSION !== SUPPORTED_PI_VERSION) {
      return `Readonly child viewing is tightly coupled to Pi ${SUPPORTED_PI_VERSION}; this process runs Pi ${VERSION}. Use the plugin tag matching your Pi version.`;
    }
  } catch {
    // SDK-shaped test hosts and non-Pi loaders need not expose runtime metadata.
  }
  return unavailableReason ?? `Native readonly child viewing requires the Pi ${SUPPORTED_PI_VERSION} TUI runtime patch. Reload the extension or restart Pi to enable native viewing.`;
}

function openView(state: Registry, mode: NativeMode, session: AgentSession, theme: Theme, options: ViewOptions): Promise<void> {
  if (state.owners.size === 0) return Promise.reject(new Error("The native session-view extension has been unloaded"));
  if (options.signal?.aborted) return Promise.resolve();
  if (state.views.has(mode)) return Promise.reject(new Error("A session view is already open"));
  if (mode.isShuttingDown) return Promise.reject(new Error("Cannot open a session view during shutdown"));

  return new Promise<void>((resolve, reject) => {
    let view: (Component & { dispose(): void }) | undefined;
    let host: ReturnType<typeof installModalHost100> | undefined;
    let modal: { close(): void } | undefined;
    let closed = false;
    const finish = (failure?: unknown) => {
      if (closed) return;
      closed = true;
      options.signal?.removeEventListener("abort", close);
      state.views.delete(mode);
      let error = failure;
      // Detach presentation before releasing its watchers/subscription. Cleanup failure
      // must settle the lease, never escape into the TUI input or session lifecycle.
      for (const cleanup of [() => modal?.close(), () => host?.dispose(), () => view?.dispose()]) {
        try { cleanup(); } catch (cause) { error ??= cause; }
      }
      if (error !== undefined) reject(error);
      else resolve();
    };
    const close = () => finish();
    state.views.set(mode, close);
    try {
      host = installModalHost100(mode.renderer);
      view = createReadOnlySessionView(mode, session, theme, close, options);
      if (closed) {
        view.dispose();
        host.dispose();
        return;
      }
      modal = host.show(view, close);
      options.signal?.addEventListener("abort", close, { once: true });
      if (options.signal?.aborted) close();
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Install before InteractiveMode creates extension UI contexts. Pi's UI wrapper
 * spreads unknown fields, so viewSession bypasses withUIPrompt and does not pause
 * Watch. We patch the runtime-exported class, never another on-disk SDK copy.
 */
export function installNativeSessionViewPatch(): NativeSessionViewPatch {
  try {
    if (VERSION !== SUPPORTED_PI_VERSION) {
      unavailableReason = getNativeSessionViewUnavailableReason();
      return { supported: false, reason: unavailableReason, dispose() {} };
    }
    const prototype = InteractiveMode.prototype as unknown as Record<PropertyKey, unknown>;
    let state = prototype[REGISTRY] as Registry | undefined;
    if (state) {
      if (!(state.owners instanceof Set) || !Array.isArray(state.hooks) || !(state.views instanceof Map)) {
        throw new Error("Native session-view patch registry is incompatible");
      }
      for (const hook of state.hooks) {
        if (Object.getOwnPropertyDescriptor(prototype, hook.name)?.value !== hook.wrapper) {
          throw new Error(`Another extension replaced Pi ${SUPPORTED_PI_VERSION} ${hook.name}; refusing to stack an unsafe view patch`);
        }
      }
      // /reload may evaluate a new plugin module while an older activation still owns
      // these hooks. Update implementation, not wrapper depth or runtime class identity.
      state.open = openView;
    } else {
      const originals = new Map<HookName, PropertyDescriptor>();
      for (const name of HOOKS) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (!descriptor || typeof descriptor.value !== "function" || (!descriptor.configurable && !descriptor.writable)) {
          throw new Error(`Pi ${SUPPORTED_PI_VERSION} native view hook ${name} is unavailable`);
        }
        originals.set(name, descriptor);
      }
      if (!Object.isExtensible(prototype)) throw new Error("Pi's InteractiveMode prototype is not extensible");
      state = { owners: new Set(), hooks: [], views: new Map(), open: openView };
      const shared = state;
      try {
      for (const name of HOOKS) {
        const original = originals.get(name)!;
        const method = original.value as NativeMethod;
        const wrapper: NativeMethod = function (...args) {
          if (shared.owners.size === 0) return method.apply(this, args);
          if (name === "createExtensionUIContext") {
            const ui = method.apply(this, args) as NativeUI;
            // Namespaced, copied with Pi's UI wrapper, used only for verified
            // user forwarding in the legacy viewer (never a global singleton).
            ui.getSubagentsMainSession = () => this.session;
            // A source-patched core already has a native implementation; don't replace it.
            if (typeof ui.viewSession !== "function") {
              ui.viewSession = (session, options = {}) => {
                // Pi may retain/copy this UI function across /reload. Resolve the
                // current activation instead of retaining an unloaded registry.
                const current = prototype[REGISTRY] as Registry | undefined;
                if (!current) return Promise.reject(new Error("The native session-view extension has been unloaded"));
                return current.open(current, this, session, ui.theme, options);
              };
            }
            return ui;
          }
          if (name === "switchTuiMode") {
            if (shared.views.has(this)) return args[0] === this.renderer.mode;
          } else {
            shared.views.get(this)?.();
          }
          return method.apply(this, args);
        };
        Object.defineProperty(prototype, name, { ...original, value: wrapper });
        state.hooks.push({ name, original, wrapper });
      }
      Object.defineProperty(prototype, REGISTRY, { value: state, configurable: true });
      } catch (error) {
        for (const hook of state.hooks.reverse()) {
          if (Object.getOwnPropertyDescriptor(prototype, hook.name)?.value === hook.wrapper) {
            Object.defineProperty(prototype, hook.name, hook.original);
          }
        }
        throw error;
      }
    }
    const shared = state;
    const owner = Symbol("native-session-view-activation");
    shared.owners.add(owner);
    unavailableReason = undefined;
    let disposed = false;
    return {
      supported: true,
      dispose() {
        if (disposed) return;
        disposed = true;
        shared.owners.delete(owner);
        if (shared.owners.size > 0) return;
        for (const close of [...shared.views.values()]) close();
        for (const hook of shared.hooks) {
          if (Object.getOwnPropertyDescriptor(prototype, hook.name)?.value === hook.wrapper) {
            Object.defineProperty(prototype, hook.name, hook.original);
          }
        }
        if (prototype[REGISTRY] === shared) delete prototype[REGISTRY];
      },
    };
  } catch (error) {
    unavailableReason = `Readonly child viewing is unavailable: ${error instanceof Error ? error.message : String(error)}. This plugin is tied to Pi ${SUPPORTED_PI_VERSION}.`;
    return { supported: false, reason: unavailableReason, dispose() {} };
  }
}
