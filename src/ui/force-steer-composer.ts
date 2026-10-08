import { type Component, Input, matchesKey, Text } from "@earendil-works/pi-tui";
import { FORCE_STEER_KEY, RETRY_PARENT_STEER_KEY } from "../user-steer.js";

export interface ForceSteerOptions {
  canSteer(): boolean;
  send(message: string): Promise<string>;
  retryParent(): Promise<string>;
  hasPendingParent(): boolean;
  requestRender(): void;
  initiallyOpen?: boolean;
}

/** Uses Pi's Input in the modal itself: no nested ui.input dialog, no parent
 * editor interception, no Watch pause, and no global shortcut registration. */
export class ForceSteerComposer implements Component {
  private input?: Input;
  private pending = false;
  status = "";
  constructor(private options: ForceSteerOptions) { if (options.initiallyOpen) this.open(); }
  get composing(): boolean { return this.input !== undefined; }

  handleInput(data: string): boolean {
    if (this.input) { this.input.handleInput(data); this.options.requestRender(); return true; }
    if (matchesKey(data, FORCE_STEER_KEY)) {
      this.open();
      return true;
    }
    if (matchesKey(data, RETRY_PARENT_STEER_KEY) && this.options.hasPendingParent()) {
      if (!this.pending) this.deliver(() => this.options.retryParent());
      return true;
    }
    return false;
  }

  open(): void {
    if (this.pending) return;
    if (!this.options.canSteer()) {
      this.status = "Cannot steer: agent is no longer running or queued";
      this.options.requestRender();
      return;
    }
    const input = new Input();
    input.focused = true;
    input.onEscape = () => { this.input = undefined; this.options.requestRender(); };
    input.onSubmit = value => {
      this.input = undefined;
      if (!value.trim()) { this.options.requestRender(); return; }
      if (!this.options.canSteer()) {
        this.status = "Cannot steer: agent finished while composing";
        this.options.requestRender();
        return;
      }
      this.deliver(() => this.options.send(value));
    };
    this.input = input;
    this.options.requestRender();
  }

  private deliver(send: () => Promise<string>): void {
    this.pending = true;
    this.status = "Sending steer…";
    this.options.requestRender();
    void Promise.resolve().then(send).then(status => { this.status = status; }, error => {
      this.status = `Steer FAILED: ${error instanceof Error ? error.message : String(error)}`;
    }).finally(() => { this.pending = false; this.options.requestRender(); });
  }

  render(width: number): string[] {
    if (this.input) return [...new Text("Force steer (bash/its attach waits only): Enter send · Esc cancel", 0, 0).render(width), ...this.input.render(width)];
    return this.status ? new Text(this.status, 0, 0).render(width) : [];
  }
  invalidate(): void { this.input?.invalidate(); }
}
