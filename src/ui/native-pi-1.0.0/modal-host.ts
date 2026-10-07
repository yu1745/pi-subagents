import { VERSION } from "@earendil-works/pi-coding-agent";
import {
	type Component, getCapabilities, isFocusable, isKeyRelease, setCapabilities, sliceByColumn,
	type Terminal, type TUI, TuiAltScreen, TuiMainScreen, type TuiMouseButton, type TuiMouseEvent,
} from "@earendil-works/pi-tui";

interface Overlay { component: Component; preFocus: Component | null; bounds?: unknown }
interface FocusRestore { status: string; overlay?: Overlay }
type Cursor = { row: number; col: number } | null;
/** Deliberately version-specific structural view of the 1.0.0 private runtime. */
interface Native extends TUI {
	getFocusedComponent(): Component | null;
	stopped: boolean;
	focusedComponent: Component | null;
	overlayStack: Overlay[];
	overlayFocusRestore: FocusRestore;
	renderedOverlayLayouts: unknown[];
	layoutRoot?: Component;
	currentLayout?: { lines: string[] };
	altScreenActive: boolean;
	imageProtocol: string | null;
	previousScreen: string[];
	previousLines: string[];
	previousKittyImageIds: Set<number>;
	previousWidth: number;
	previousHeight: number;
	previousViewportTop: number;
	maxLinesRendered: number;
	cursorRow: number;
	hardwareCursorRow: number;
	lastClick?: unknown;
	lastComponentClick?: unknown;
	scrollToEndIndicatorRect?: unknown;
	activeSearch?: { component: { setHoveredNavigationDirection(value: undefined): void } };
	hasOverlayEntries: boolean;
	doRender(): void;
	resetRenderState(): void;
	handleTerminalInput(data: string): void;
	consumeTerminalColorResponse(data: string): boolean;
	consumeTerminalColorSchemeReport(data: string): boolean;
	consumeCellSizeResponse(data: string): boolean;
	requestImmediateRender(): void;
	setFocusInternal(value: { component: Component | null; overlayFocusRestore: string }): void;
	isComponentMounted(component: Component): boolean;
	isOverlayVisible(overlay: Overlay): boolean;
	getTopmostVisibleOverlay(): Overlay | undefined;
	clearOverlayFocusRestore(): void;
	hideTerminalCursor(): void;
	clearTextSelection(): void;
	stopScrollbarHover(): void;
	stopScrollbarDrag(): void;
	clearComponentMouseGesture(): void;
	refreshSearch(...args: unknown[]): boolean;
	applySearchHighlights(lines: string[], ...args: unknown[]): string[];
	compositeScrollToEndIndicator(lines: string[], ...args: unknown[]): string[];
	compositeOverlays(lines: string[], width: number, height: number): string[];
	applySelection(lines: string[], ...args: unknown[]): string[];
	compositeFlashes(lines: string[], ...args: unknown[]): string[];
	extractCursorPosition(lines: string[], height: number): Cursor;
	applyLineResets(lines: string[]): string[];
	collectKittyImageIds(lines: string[]): Set<number>;
	deleteKittyImages(ids: Iterable<number>): string;
	positionHardwareCursor(cursor: Cursor, length: number): void;
	getShowHardwareCursor(): boolean;
	getClearOnShrink(): boolean;
}

const installed = new WeakSet<TUI>();
const imageLine = (line: string): boolean => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
const layers = ["applySearchHighlights", "compositeScrollToEndIndicator", "compositeOverlays", "applySelection", "compositeFlashes"] as const;

/** Install only on the exact bundled Pi 1.0.0 runtime; never modify a prototype. */
export function installModalHost100(tui: TUI): { show(component: Component, onClose?: () => void): { close(): void }; dispose(): void } {
	// Read the host's virtual-module version, not metadata from another on-disk SDK copy.
	const fullscreen = tui.mode === "fullscreen";
	const prototype = fullscreen ? TuiAltScreen.prototype : TuiMainScreen.prototype;
	const n = tui as Native;
	const hooks = ["doRender", "resetRenderState", "handleTerminalInput", "setFocusInternal", "getFocusedComponent", "hasOverlay", "invalidate", "stop", "showOverlay", "consumeTerminalColorResponse", "consumeTerminalColorSchemeReport", "consumeCellSizeResponse", "isComponentMounted", "isOverlayVisible", "getTopmostVisibleOverlay", "clearOverlayFocusRestore", "hideTerminalCursor", "requestImmediateRender", "extractCursorPosition", "applyLineResets", ...(fullscreen ? ["refreshSearch", ...layers, "clearTextSelection", "stopScrollbarHover", "stopScrollbarDrag", "clearComponentMouseGesture"] : ["collectKittyImageIds", "deleteKittyImages", "positionHardwareCursor", "compositeOverlays"])] as const;
	if (VERSION !== "1.0.0" || Object.getPrototypeOf(tui) !== prototype || installed.has(tui) || !Object.isExtensible(tui)) throw new Error("Modal host requires an extensible, unclaimed bundled Pi 1.0.0 TUI");
	for (const key of hooks) {
		const own = Object.getOwnPropertyDescriptor(tui, key);
		if (own && !own.configurable) throw new Error(`Non-configurable Pi 1.0.0 hook: ${key}`);
		const expected = Reflect.get(prototype, key);
		if (typeof expected !== "function" || Reflect.get(tui, key) !== expected) throw new Error(`Unsupported Pi 1.0.0 hook: ${key}`);
	}
	if (!Array.isArray(n.overlayStack) || !(fullscreen ? Array.isArray(n.previousScreen) : Array.isArray(n.previousLines) && n.previousKittyImageIds instanceof Set)) throw new Error("Unsupported Pi 1.0.0 renderer state");

	const restores: Array<() => void> = [];
	function patch<K extends keyof Native>(key: K, value: Native[K]): void {
		const descriptor = Object.getOwnPropertyDescriptor(n, key);
		Object.defineProperty(n, key, { configurable: true, writable: true, value });
		restores.push(() => {
			if (Object.getOwnPropertyDescriptor(n, key)?.value !== value) return;
			if (descriptor) Object.defineProperty(n, key, descriptor);
			else Reflect.deleteProperty(n, key);
		});
	}
	const nativeRender = n.doRender.bind(n);
	const nativeReset = n.resetRenderState.bind(n);
	const nativeInput = n.handleTerminalInput.bind(n);
	const nativeFocus = n.setFocusInternal.bind(n);
	const nativeInvalidate = n.invalidate.bind(n);
	const nativeStop = n.stop.bind(n);
	const nativeHasOverlay = n.hasOverlay.bind(n);
	const nativeShowOverlay = n.showOverlay.bind(n);
	let active: { component: Component; requests: Array<Component | null>; close(): void } | undefined;
	let disposed = false;
	let restoreViewport = false;
	let modalImages = new Set<number>();
	let helper: Native | undefined;
	// Existing overlay handles close over this field. Expose no background focus
	// outside native bookkeeping while preserving the real overlay stack.
	let backgroundFocus = n.focusedComponent;
	let bookkeeping = false;
	const focusDescriptor = Object.getOwnPropertyDescriptor(n, "focusedComponent");
	if (!focusDescriptor?.configurable || !("value" in focusDescriptor)) throw new Error("Unsupported Pi focus field");
	const focusGetter = (): Component | null => active && !bookkeeping ? null : backgroundFocus;
	Object.defineProperty(n, "focusedComponent", {
		configurable: true, get: focusGetter, set: (value: Component | null) => { backgroundFocus = value; },
	});
	restores.push(() => {
		if (Object.getOwnPropertyDescriptor(n, "focusedComponent")?.get === focusGetter) {
			Object.defineProperty(n, "focusedComponent", { ...focusDescriptor, value: backgroundFocus });
		}
	});

	function boundary(): void {
		n.renderedOverlayLayouts = [];
		for (const overlay of n.overlayStack) overlay.bounds = undefined;
		if (!fullscreen) return;
		n.clearTextSelection();
		n.stopScrollbarHover();
		n.stopScrollbarDrag();
		n.clearComponentMouseGesture();
		n.lastClick = undefined;
		n.lastComponentClick = undefined;
		n.scrollToEndIndicatorRect = undefined;
		n.activeSearch?.component.setHoveredNavigationDirection(undefined);
		n.previousScreen = [];
	}

	function paint(lines: string[], ids: Iterable<number>): void {
		const { columns: width, rows: height } = tui.terminal;
		let output = `\x1b[?2026h${n.deleteKittyImages(ids)}`;
		// Clear every target row before any image placement (WezTerm's EL erases images).
		for (let row = 0; row < height; row++) output += `\x1b[${row + 1};1H\x1b[2K`;
		for (let row = 0; row < height; row++) {
			const line = lines[row] ?? "";
			output += `\x1b[${row + 1};1H${imageLine(line) ? line : sliceByColumn(line, 0, width, true)}`;
		}
		tui.terminal.write(`${output}\x1b[?25l\x1b[?2026l`);
	}

	function renderModal(component: Component): void {
		if (fullscreen) {
			const root = n.layoutRoot;
			const layout = n.currentLayout;
			n.layoutRoot = component;
			const capabilities = getCapabilities();
			try {
				if (capabilities.images === "iterm2") setCapabilities({ ...capabilities, images: null });
				nativeRender();
			} finally {
				n.layoutRoot = root;
				n.currentLayout = layout;
				setCapabilities(capabilities);
			}
			return;
		}
		if (!helper) {
			// A layout executor, not a runtime: no input, output, start/stop, or scheduler.
			const noop = (): void => {};
			const inert: Terminal = {
				get columns() { return tui.terminal.columns; }, get rows() { return tui.terminal.rows; },
				kittyProtocolActive: false, start: noop, stop: noop, drainInput: async () => {}, write: noop,
				moveBy: noop, hideCursor: noop, showCursor: noop, clearLine: noop, clearFromCursor: noop,
				clearScreen: noop, setTitle: noop, setProgress: noop,
			};
			helper = new TuiAltScreen(inert) as unknown as Native;
			helper.stopped = false;
			helper.altScreenActive = true;
			helper.imageProtocol = null;
			helper.requestRender = () => tui.requestRender();
		}
		helper.layoutRoot = component;
		const capabilities = getCapabilities();
		try {
			if (capabilities.images === "iterm2") setCapabilities({ ...capabilities, images: null });
			helper.doRender();
		} finally { setCapabilities(capabilities); }
		const lines = [...(helper.currentLayout?.lines ?? [])];
		const cursor = n.extractCursorPosition(lines, tui.terminal.rows);
		restoreViewport = true;
		paint(n.applyLineResets(lines), new Set([...n.previousKittyImageIds, ...modalImages]));
		modalImages = n.collectKittyImageIds(lines);
		if (cursor) {
			tui.terminal.write(`\x1b[${cursor.row + 1};${Math.min(tui.terminal.columns - 1, cursor.col) + 1}H`);
			if (n.getShowHardwareCursor()) tui.terminal.showCursor();
		}
	}

	function restoreParent(): void {
		if (!restoreViewport) return;
		const { columns: width, rows: height } = tui.terminal;
		let lines = n.render(width);
		if (n.hasOverlayEntries) lines = n.compositeOverlays(lines, width, height);
		const cursor = n.extractCursorPosition(lines, height);
		lines = n.applyLineResets(lines);
		const repaint = n.previousWidth !== width || n.previousHeight !== height || !n.previousLines.length ||
			lines.length < n.previousLines.length || (n.getClearOnShrink() && lines.length < n.maxLinesRendered) ||
			n.previousKittyImageIds.size > 0 || lines.some(imageLine) ||
			n.previousLines.slice(0, n.previousViewportTop).some((line, index) => line !== lines[index]);
		if (repaint) {
			const top = Math.max(0, lines.length - height);
			paint(lines.slice(top), modalImages);
			n.previousLines = lines;
			n.previousKittyImageIds = n.collectKittyImageIds(lines);
			n.previousWidth = width;
			n.previousHeight = height;
			n.previousViewportTop = top;
			n.maxLinesRendered = lines.length;
			n.cursorRow = Math.max(0, lines.length - 1);
			n.hardwareCursorRow = top + height - 1;
			n.positionHardwareCursor(cursor, lines.length);
		} else {
			paint(n.previousLines.slice(n.previousViewportTop), modalImages);
			tui.terminal.write(`\x1b[${Math.max(0, Math.min(height - 1, n.hardwareCursorRow - n.previousViewportTop)) + 1};1H`);
			// Continue native diff with the already-rendered frame. Rendering components
			// twice here could consume a loader frame or change the suspended prefix.
			const replacements = {
				render: () => lines,
				compositeOverlays: () => lines,
				extractCursorPosition: () => cursor,
				applyLineResets: () => lines,
			};
			const descriptors = new Map<string, PropertyDescriptor | undefined>();
			for (const [key, value] of Object.entries(replacements)) {
				descriptors.set(key, Object.getOwnPropertyDescriptor(n, key));
				Object.defineProperty(n, key, { configurable: true, writable: true, value });
			}
			try { nativeRender(); }
			finally {
				for (const [key, value] of Object.entries(replacements)) {
					if (Object.getOwnPropertyDescriptor(n, key)?.value !== value) continue;
					const descriptor = descriptors.get(key);
					if (descriptor) Object.defineProperty(n, key, descriptor);
					else Reflect.deleteProperty(n, key);
				}
			}
		}
		modalImages.clear();
		restoreViewport = false;
	}

	patch("doRender", () => {
		if (n.stopped) return;
		if (active) renderModal(active.component);
		else if (restoreViewport) restoreParent();
		else nativeRender();
	});
	patch("resetRenderState", () => {
		if (active || restoreViewport) { if (fullscreen) n.previousScreen = []; return; }
		nativeReset();
	});
	patch("getFocusedComponent", () => active?.component ?? n.focusedComponent);
	patch("setFocusInternal", (value) => {
		if (!active) return nativeFocus(value);
		active.requests.push(value.component);
		// Keep native overlay bookkeeping, but do not let background setters focus an editor.
		const target = value.component;
		const descriptor = target && Object.getOwnPropertyDescriptor(target, "focused");
		bookkeeping = true;
		try {
		if (target && isFocusable(target) && (!descriptor || descriptor.configurable)) {
			Object.defineProperty(target, "focused", { configurable: true, get: () => false, set: () => {} });
			try { nativeFocus(value); } finally {
				if (descriptor) Object.defineProperty(target, "focused", descriptor);
				else Reflect.deleteProperty(target, "focused");
				if (isFocusable(target)) target.focused = false;
			}
		} else { nativeFocus(value); }
		if (isFocusable(backgroundFocus)) backgroundFocus.focused = false;
		} finally { bookkeeping = false; }
	});
	patch("showOverlay", (component, options) => {
		bookkeeping = true;
		try { return nativeShowOverlay(component, options); }
		finally { bookkeeping = false; if (active) boundary(); }
	});
	patch("hasOverlay", () => !active && nativeHasOverlay());
	patch("invalidate", () => { active?.component.invalidate(); nativeInvalidate(); });
	if (fullscreen) {
		const refresh = n.refreshSearch.bind(n);
		patch("refreshSearch", (...args) => active ? false : refresh(...args));
		for (const key of layers) {
			const original = n[key].bind(n);
			patch(key, (lines: string[], ...args: unknown[]) => active ? lines : Reflect.apply(original, n, [lines, ...args]));
		}
	}
	patch("handleTerminalInput", (data) => {
		if (!active) return nativeInput(data);
		if (n.consumeTerminalColorResponse(data) || n.consumeTerminalColorSchemeReport(data) || n.consumeCellSizeResponse(data)) return;
		const component = active.component;
		const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		const legacy = data.length === 6 && data.startsWith("\x1b[M");
		if (sgr || legacy) {
			const button = sgr ? Number(sgr[1]) : data.charCodeAt(3) - 32;
			const x = sgr ? Number(sgr[2]) - 1 : data.charCodeAt(4) - 33;
			const y = sgr ? Number(sgr[3]) - 1 : data.charCodeAt(5) - 33;
			const wheel = (button & 64) !== 0;
			const released = sgr ? sgr[4] === "m" : (button & 3) === 3;
			const motion = (button & 32) !== 0;
			const mouseButton = ["left", "middle", "right", "none"][button & 3] as TuiMouseButton;
			const event: TuiMouseEvent = {
				type: wheel ? "wheel" : released ? "release" : motion ? (mouseButton === "none" ? "move" : "drag") : "press",
				button: wheel ? "none" : mouseButton, x, y, screenX: x, screenY: y,
				width: Math.max(1, tui.terminal.columns), height: Math.max(1, tui.terminal.rows),
				shift: (button & 4) !== 0, alt: (button & 8) !== 0, ctrl: (button & 16) !== 0,
				...(wheel ? { wheelDelta: (button & 1) === 0 ? -1 : 1 } : {}),
			};
			const result = component.handleMouse?.(event);
			if (result?.render ?? (event.type !== "move" && event.type !== "release")) tui.requestRender();
			return;
		}
		if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M") || data === "\x1b[I" || data === "\x1b[O") return;
		if (!isKeyRelease(data) || component.wantsKeyRelease) { component.handleInput?.(data); n.requestImmediateRender(); }
	});

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		try { active?.close(); }
		finally {
			try { if (restoreViewport) restoreParent(); }
			finally {
				for (const restore of restores.reverse()) restore();
				installed.delete(tui);
				helper = undefined;
			}
		}
	}
	patch("stop", (options) => { try { dispose(); } finally { nativeStop(options); } });
	installed.add(tui);
	return {
		dispose,
		show(component, onClose) {
			if (disposed) throw new Error("Modal host is disposed");
			if (active) throw new Error("A modal view is already open");
			const originalFocus = n.focusedComponent;
			const originalOverlay = n.overlayStack.find((entry) => entry.component === originalFocus);
			const originalWasMounted = originalFocus !== null && n.isComponentMounted(originalFocus);
			const originalOverlays = new Set(n.overlayStack);
			const focusRestore = n.overlayFocusRestore;
			const scope = { component, requests: [] as Array<Component | null>, close: () => {
				if (active !== scope) return;
				const usable = (target: Component | null): target is Component => {
					if (!target) return false;
					const overlay = n.overlayStack.find((entry) => entry.component === target);
					if (overlay) return n.isOverlayVisible(overlay);
					if (target === originalFocus && originalOverlay) return false;
					return n.isComponentMounted(target) || (target === originalFocus && !originalWasMounted);
				};
				const pending = [...scope.requests].reverse().find(usable);
				const editor = [...scope.requests].reverse().find((target) => target !== null && n.isComponentMounted(target));
				const top = n.getTopmostVisibleOverlay();
				const queued = top && !originalOverlays.has(top) ? top.component : undefined;
				const next = queued ?? (usable(originalFocus) ? originalFocus : pending ?? top?.component ?? (usable(originalOverlay?.preFocus ?? null) ? originalOverlay!.preFocus : null));
				for (const overlay of n.overlayStack) if (overlay.preFocus && !usable(overlay.preFocus)) overlay.preFocus = editor ?? null;
				if (isFocusable(component)) component.focused = false;
				active = undefined;
				n.clearOverlayFocusRestore();
				nativeFocus({ component: next, overlayFocusRestore: "clear" });
				if (next === originalFocus && focusRestore.status !== "inactive" && focusRestore.overlay && n.overlayStack.includes(focusRestore.overlay) && n.isOverlayVisible(focusRestore.overlay)) n.overlayFocusRestore = focusRestore;
				boundary();
				if (!n.stopped) tui.requestRender();
				onClose?.();
			} };
			active = scope;
			if (isFocusable(backgroundFocus)) backgroundFocus.focused = false;
			if (isFocusable(component)) component.focused = true;
			boundary();
			n.hideTerminalCursor();
			tui.requestRender();
			return { close: scope.close };
		},
	};
}
