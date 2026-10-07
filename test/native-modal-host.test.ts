import { type Component, getCapabilities, Image, ScrollView, setCapabilities, setCellDimensions, type Terminal, TuiAltScreen, TuiMainScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { installModalHost100 } from "../src/ui/native-pi-1.0.0/modal-host.js";

class FakeTerminal implements Terminal {
	columns = 40;
	rows = 8;
	kittyProtocolActive = false;
	writes: string[] = [];
	starts = 0;
	stops = 0;
	input: (data: string) => void = () => {};
	resize: () => void = () => {};
	start(input: (data: string) => void, resize: () => void): void { this.starts++; this.input = input; this.resize = resize; }
	stop(): void { this.stops++; }
	async drainInput(): Promise<void> {}
	write(data: string): void { this.writes.push(data); }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}
class Recorder implements Component {
	focused = false;
	inputs: string[] = [];
	mouse: TuiMouseEvent[] = [];
	lines = ["draft"];
	renders = 0;
	invalidations = 0;
	render(): string[] { this.renders++; return [...this.lines]; }
	invalidate(): void { this.invalidations++; }
	handleInput(data: string): void { this.inputs.push(data); }
	handleMouse(event: TuiMouseEvent): undefined { this.mouse.push(event); }
}
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	describe(Renderer.name, () => {
		it("isolates native input and rendering while background progress and overlays continue", () => {
			const terminal = new FakeTerminal();
			const tui = new Renderer(terminal);
			const editor = new Recorder();
			tui.addChild(editor); tui.setFocus(editor); tui.start(); tui.renderNow();
			const host = installModalHost100(tui);
			try {
				const modal = new Recorder(); modal.lines = ["modal"];
				const prior = tui.showOverlay(new Recorder()); tui.renderNow();
				const scope = host.show(modal);
				expect(prior.isFocused()).toBe(false); expect(prior.getBounds()).toBeUndefined();
				expect(() => host.show(modal)).toThrow(/already open/);
				let listeners = 0;
				tui.addInputListener(() => { listeners++; return undefined; });
				for (const key of ["q", "\x03", "\x1b[200~paste\x1b[201~"]) terminal.input(key);
				for (const report of ["\x1b[113;1:3u", "\x1b[6;20;10t", "\x1b[?997;1n", "\x1b[<broken", "\x1b[I"]) terminal.input(report);
				terminal.input("\x1b[<65;2;3M"); terminal.input("\x1b[M`!!");
				expect(modal.inputs).toHaveLength(3); expect(modal.mouse.map((event) => event.type)).toEqual(["wheel", "wheel"]);
				expect(listeners).toBe(0); expect(editor.inputs).toEqual([]);
				const renders = editor.renders;
				editor.lines.push("background");
				const dialog = new Recorder(); const overlay = tui.showOverlay(dialog);
				tui.setFocus(dialog); tui.renderNow();
				expect(tui.getFocusedComponent()).toBe(modal); expect(dialog.focused).toBe(false);
				expect(editor.renders).toBe(renders); expect(tui.hasOverlay()).toBe(false);
				expect(overlay.isFocused()).toBe(false); expect(overlay.getBounds()).toBeUndefined();
				terminal.rows = 10; terminal.columns = 50; tui.requestRender(true); tui.renderNow();
				expect(editor.renders).toBe(renders);
				scope.close(); scope.close(); tui.renderNow();
				expect(tui.getFocusedComponent()).toBe(dialog); overlay.hide(); prior.hide();
				expect(tui.getFocusedComponent()).toBe(editor);
				expect(terminal.starts).toBe(1);
			} finally { host.dispose(); host.dispose(); tui.stop(); }
		});
		it("restores replacement editors, preserves descriptor ownership, and detaches on stop", () => {
			const terminal = new FakeTerminal(); const tui = new Renderer(terminal);
			const editor = new Recorder(); tui.addChild(editor); tui.setFocus(editor); tui.start();
			const host = installModalHost100(tui); const dialog = tui.showOverlay(new Recorder());
			const scope = host.show(new Recorder());
			tui.removeChild(editor); const replacement = new Recorder(); tui.addChild(replacement); tui.setFocus(replacement); dialog.hide();
			scope.close(); expect(tui.getFocusedComponent()).toBe(replacement);
			const foreign = () => false; tui.hasOverlay = foreign;
			host.show(new Recorder()); tui.stop(); tui.stop(); host.dispose(); scope.close();
			expect(tui.hasOverlay).toBe(foreign);
			expect(Object.hasOwn(tui, "doRender")).toBe(false);
			expect(() => host.show(editor)).toThrow(/disposed/);
		});
	});
}
it("regular mode freezes history and appends background output once, without clearing scrollback", () => {
	const terminal = new FakeTerminal(); const tui = new TuiMainScreen(terminal);
	const editor = new Recorder(); editor.lines = Array.from({ length: 20 }, (_, i) => `history ${i}`);
	tui.addChild(editor); tui.start(); tui.renderNow();
	const before = tui.captureRenderState(); const host = installModalHost100(tui); const scope = host.show(new Recorder());
	try {
		tui.renderNow(); editor.lines.push("unique append"); tui.requestRender(true); tui.renderNow();
		expect(tui.captureRenderState()).toEqual(before);
		terminal.writes = []; scope.close(); tui.renderNow(); tui.renderNow();
		expect(terminal.writes.join("").match(/unique append/g)).toHaveLength(1);
		expect(terminal.writes.join("")).not.toContain("\x1b[3J");
		const second = host.show(new Recorder()); tui.renderNow(); terminal.columns = 50; terminal.rows = 10;
		tui.requestRender(true); tui.renderNow(); terminal.writes = []; second.close(); tui.renderNow();
		expect(terminal.writes.join("")).not.toContain("\x1b[3J");
		expect(terminal.writes.join("")).not.toContain("history 0");
	} finally { host.dispose(); tui.stop(); }
});
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	it(`${Renderer.name} closes the owner exactly once on direct stop, including reentrant cleanup`, () => {
		const tui = new Renderer(new FakeTerminal()); tui.start();
		const host = installModalHost100(tui); let calls = 0;
		const scope = host.show(new Recorder(), () => {
			calls++; scope.close(); host.dispose();
			expect(tui.getFocusedComponent()).not.toBe(modal);
		});
		const modal = tui.getFocusedComponent();
		tui.renderNow(); tui.stop(); host.dispose(); scope.close();
		expect(calls).toBe(1); expect(Object.hasOwn(tui, "stop")).toBe(false);
	});
	it(`${Renderer.name} uses bundled Kitty crop metadata for modal ScrollViews and reentry`, () => {
		const capabilities = getCapabilities();
		setCapabilities({ ...capabilities, images: "kitty" }); setCellDimensions({ widthPx: 10, heightPx: 20 });
		const terminal = new FakeTerminal(); const tui = new Renderer(terminal); tui.start();
		const host = installModalHost100(tui);
		try {
			const image = new Image("AAAA", "image/png", { fallbackColor: (text) => text }, { imageId: 34567, maxHeightCells: 30 }, { widthPx: 200, heightPx: 600 });
			const scroll = new ScrollView(image, { scrollbar: "hidden" });
			for (let cycle = 0; cycle < 2; cycle++) {
				const scope = host.show(scroll); tui.renderNow(); scroll.scrollTo(5);
				terminal.writes = []; tui.renderNow();
				const output = terminal.writes.join("");
				expect(output).toContain("\x1b_G"); expect(output).toMatch(/(?:^|,)y=100(?:,|;)/);
				expect(scroll.viewportHeight).toBe(8);
				if (Renderer === TuiMainScreen) {
					expect(output.lastIndexOf("\x1b[2K")).toBeLessThan(output.indexOf("\x1b_G", output.indexOf("\x1b[2K")));
					expect(output).not.toContain("\x1b[?1049");
				}
				scope.close(); tui.renderNow(); scroll.scrollToStart();
			}
			expect(terminal.starts).toBe(1);
		} finally { host.dispose(); tui.stop(); setCapabilities(capabilities); }
	});
}
it("suspends parent scroll, search and gestures across forced frames and resize", () => {
	const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal);
	const editor = new Recorder(); editor.lines = Array.from({ length: 100 }, (_, i) => `row ${i}`);
	const scroll = new ScrollView(editor, { primary: true, follow: "end", scrollbar: "always" });
	tui.setLayoutRoot(scroll); tui.setFocus(editor); tui.start(); tui.renderNow(); scroll.scrollTo(30); tui.renderNow();
	terminal.input("\x1b[102;6u"); terminal.input("row 40"); tui.renderNow();
	const search = tui.getFocusedComponent(); const top = scroll.scrollTop;
	const host = installModalHost100(tui);
	try {
		const scope = host.show(new Recorder()); editor.lines.push("background row");
		terminal.rows = 10; tui.requestRender(true); tui.renderNow();
		expect(scroll.scrollTop).toBe(top); expect(scroll.viewportHeight).toBe(8); expect(scroll.isFollowingEnd).toBe(false);
		terminal.input("\x1b[<32;40;10M"); terminal.input("\x1b"); scope.close(); tui.renderNow();
		expect(tui.getFocusedComponent()).toBe(search); expect(scroll.scrollTop).toBe(top);
		expect(editor.lines[0]).toBe("row 0"); expect(tui.hasActiveSelection()).toBe(false);
	} finally { host.dispose(); tui.stop(); }
});
it("fails closed for subclasses, nonextensible instances and prepatched hooks", () => {
	class Other extends TuiMainScreen {}
	expect(() => installModalHost100(new Other(new FakeTerminal()))).toThrow(/bundled/);
	const fixed = new TuiMainScreen(new FakeTerminal());
	const focus = Object.getOwnPropertyDescriptor(fixed, "focusedComponent");
	Object.preventExtensions(fixed);
	expect(() => installModalHost100(fixed)).toThrow(/extensible/);
	expect(Object.getOwnPropertyDescriptor(fixed, "focusedComponent")).toEqual(focus);
	const tui = new TuiMainScreen(new FakeTerminal()); tui.invalidate = () => {};
	expect(() => installModalHost100(tui)).toThrow(/hook/);
});
