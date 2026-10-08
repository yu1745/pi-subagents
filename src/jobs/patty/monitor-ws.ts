// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
import { MONITOR_FRAME_BYTES, openMonitorCapture } from "./monitor-capture.js";

export interface WsSpec {
    url: string;
    protocols?: string[];
}

export interface WsSource {
    /** Resolves when the socket closes (0 = clean close, 1 = error/abnormal). */
    exit: Promise<number>;
    close: () => void;
}

export function isWsSupported(): boolean {
    return typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function";
}

/** Each text frame becomes a line. Oversized frames fail the source rather than
 * silently emitting an incomplete event. Retained output rolls independently. */
export function openWsSource(spec: WsSpec, logPath: string): WsSource {
    if (!isWsSupported()) {
        throw new Error("WebSocket is not available in this runtime (needs Node 22+). Use a command source instead.");
    }
    const capture = openMonitorCapture(logPath);
    const WS = (globalThis as { WebSocket: typeof WebSocket }).WebSocket;
    let ws: WebSocket;
    try { ws = new WS(spec.url, spec.protocols); }
    catch (error) { capture.close(); throw error; }
    let settled = false;
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
    const settle = (code: number): void => {
        if (settled) return;
        settled = true;
        try {
            ws.removeEventListener?.("message", onMessage);
            ws.removeEventListener?.("error", onError);
            ws.removeEventListener?.("close", onClose);
        } catch { code = 1; }
        try { capture.close(); } catch { code = 1; }
        resolveExit(code);
    };
    const closeSocket = () => { try { ws.close(); } catch { /* already closed */ } };
    const fail = () => {
        // Settle first: a mock/runtime can dispatch close synchronously.
        settle(1);
        closeSocket();
    };
    const append = (line: string): boolean => {
        if (settled) return false;
        try {
            // Bound allocation before UTF-8 encoding as well as encoded bytes.
            if (line.length > MONITOR_FRAME_BYTES) throw new Error("Oversized monitor frame");
            const bytes = Buffer.from(line.endsWith("\n") ? line : `${line}\n`);
            if (bytes.byteLength > MONITOR_FRAME_BYTES) throw new Error("Oversized monitor frame");
            capture.write(bytes);
            return true;
        } catch { fail(); return false; }
    };
    function onMessage(ev: MessageEvent) {
        if (settled) return;
        const data: unknown = ev.data;
        if (typeof data === "string") append(data);
        else {
            const size = data instanceof ArrayBuffer ? data.byteLength
                : data && typeof (data as { byteLength?: unknown }).byteLength === "number"
                    ? (data as { byteLength: number }).byteLength
                    : data && typeof (data as { size?: unknown }).size === "number"
                        ? (data as { size: number }).size : undefined;
            if (size !== undefined && size > MONITOR_FRAME_BYTES) { fail(); return; }
            append(size === undefined ? "[non-text frame]" : `[binary frame, ${size} bytes]`);
        }
    }
    function onError() {
        append("[websocket error]");
        fail();
    }
    function onClose(ev: CloseEvent) {
        if (append(`[socket closed: code ${ev.code}${ev.reason ? ` ${ev.reason}` : ""}]`)) {
            settle(ev.code === 1000 || ev.code === 1005 ? 0 : 1);
        }
    }
    try {
        ws.addEventListener("message", onMessage);
        ws.addEventListener("error", onError);
        ws.addEventListener("close", onClose);
    } catch (error) { fail(); throw error; }
    return {
        exit,
        close() { settle(0); closeSocket(); },
    };
}
