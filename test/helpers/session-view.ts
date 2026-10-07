import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { SessionViewUI } from "../../src/ui/session-view.js";

/** Contract stub, not a second renderer. Tests decide when core has detached. */
export function nativeViewer(detachOnAbort = true) {
  const views: {
    session: AgentSession;
    options: { title?: string; signal?: AbortSignal };
    detached: boolean;
    close(): void;
    fail(error: Error): void;
  }[] = [];
  const viewSession = vi.fn<NonNullable<SessionViewUI["viewSession"]>>((session, options = {}) =>
    new Promise<void>((resolve, reject) => {
      const view = {
        session,
        options,
        detached: false,
        close: () => { detach(); resolve(); },
        fail: (error: Error) => { detach(); reject(error); },
      };
      const onAbort = () => { if (detachOnAbort) view.close(); };
      const detach = () => {
        view.detached = true;
        options.signal?.removeEventListener("abort", onAbort);
      };
      views.push(view);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    }),
  );
  return { viewSession, views };
}

/** Drain the helper, native promise and caller's close/finally continuations. */
export async function flushViews() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
