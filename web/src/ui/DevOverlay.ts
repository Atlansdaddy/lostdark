/**
 * wAIver — on-screen diagnostics surfaces.
 *
 * Devtools aren't reachable during the phone/LAN testing this project relies on,
 * so failures need to be visible AND copyable on the device itself. Two surfaces,
 * both built from dynamic DOM (no index.html churn):
 *
 *   • Log panel  — the ring buffer, color-coded, toggled by the config hotkey or
 *                  window.waiver.showLogs(); a Copy button dumps it to clipboard.
 *   • Crash card — full-screen, shown by the frame-loop boundary / global error
 *                  handlers. Friendly message + the error + the last log lines +
 *                  Copy diagnostics + Reload. A lighter "notice" variant is used
 *                  for recoverable pauses (e.g. WebGL context lost).
 */
import { Debug } from '../config';
import { dumpLogs, formatEntry, getLogBuffer, logger, subscribe, type LogEntry } from '../core/log';

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  error: '#ff7a7a',
  warn: '#ffcf6b',
  info: '#9fd3e6',
  debug: '#a7d98a',
  trace: '#9aa4b2',
};

const log = logger('overlay');

export class DevOverlay {
  private panel!: HTMLDivElement;
  private logBody!: HTMLDivElement;
  private crash!: HTMLDivElement;
  private crashTitle!: HTMLDivElement;
  private crashMsg!: HTMLDivElement;
  private crashDetail!: HTMLPreElement;
  private crashError: unknown = null;
  private visible = false;
  private unsub: (() => void) | null = null;

  constructor() {
    this.injectStyles();
    this.buildPanel();
    this.buildCrash();
    document.body.append(this.panel, this.crash);

    window.addEventListener('keydown', (e) => {
      // Ignore auto-repeat and modifier combos; the hotkey is a bare press.
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === Debug.overlayHotkey) {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  // ---- log panel ----------------------------------------------------------

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.panel.style.display = 'flex';
    this.renderAll();
    // Only stream new lines into the DOM while the panel is actually open.
    this.unsub = subscribe((e) => this.appendLine(e));
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.panel.style.display = 'none';
    this.unsub?.();
    this.unsub = null;
  }

  private renderAll(): void {
    this.logBody.textContent = '';
    const buf = getLogBuffer();
    // Cap DOM to the tail so a full buffer doesn't lag the panel open.
    const start = Math.max(0, buf.length - 300);
    for (let i = start; i < buf.length; i++) this.appendLine(buf[i]);
    this.logBody.scrollTop = this.logBody.scrollHeight;
  }

  private appendLine(e: LogEntry): void {
    const atBottom =
      this.logBody.scrollHeight - this.logBody.scrollTop - this.logBody.clientHeight < 40;
    const row = document.createElement('div');
    row.className = 'wv-log-row';
    row.style.color = LEVEL_COLOR[e.level];
    row.textContent = formatEntry(e);
    this.logBody.appendChild(row);
    while (this.logBody.childElementCount > 400) this.logBody.firstElementChild?.remove();
    if (atBottom) this.logBody.scrollTop = this.logBody.scrollHeight;
  }

  // ---- crash / notice cards ----------------------------------------------

  /** Fatal: something threw. Shows the error + recent logs; loop is expected
   *  to have halted before calling this. */
  showCrash(err: unknown, message = 'Something went wrong.'): void {
    this.crashError = err;
    this.crash.classList.remove('wv-notice');
    this.crashTitle.textContent = 'wAIver hit an error';
    this.crashMsg.textContent = message;
    this.crashDetail.textContent = this.diagnostics(err);
    this.crash.style.display = 'flex';
  }

  /** Recoverable pause (e.g. WebGL context lost) — softer styling, no error. */
  showNotice(title: string, message: string): void {
    this.crashError = null;
    this.crash.classList.add('wv-notice');
    this.crashTitle.textContent = title;
    this.crashMsg.textContent = message;
    this.crashDetail.textContent = '';
    this.crash.style.display = 'flex';
  }

  hideCrash(): void {
    this.crash.style.display = 'none';
  }

  private diagnostics(err: unknown): string {
    const head =
      err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
    const tail = getLogBuffer().slice(-20).map(formatEntry).join('\n');
    return `${head}\n\n— recent log —\n${tail}`;
  }

  private async copy(text: string, btn: HTMLButtonElement): Promise<void> {
    const label = btn.textContent ?? 'Copy';
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied ✓';
    } catch {
      // Clipboard API needs a secure context / permission — fall back to select.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      if (!ok) {
        log.warn('clipboard unavailable — dumping diagnostics to console');
        console.log(text);
      }
    }
    setTimeout(() => {
      btn.textContent = label;
    }, 1500);
  }

  // ---- DOM construction ---------------------------------------------------

  private buildPanel(): void {
    const panel = document.createElement('div');
    panel.id = 'wv-log';
    panel.style.display = 'none';

    const bar = document.createElement('div');
    bar.className = 'wv-log-bar';

    const title = document.createElement('span');
    title.className = 'wv-log-title';
    title.textContent = 'logs';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'wv-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = () => void this.copy(dumpLogs(), copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'wv-btn';
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => this.hide();

    bar.append(title, copyBtn, closeBtn);

    const body = document.createElement('div');
    body.className = 'wv-log-body';

    panel.append(bar, body);
    this.panel = panel;
    this.logBody = body;
  }

  private buildCrash(): void {
    const overlay = document.createElement('div');
    overlay.id = 'wv-crash';
    overlay.style.display = 'none';

    const card = document.createElement('div');
    card.className = 'wv-crash-card';

    const title = document.createElement('div');
    title.className = 'wv-crash-title';

    const msg = document.createElement('div');
    msg.className = 'wv-crash-msg';

    const detail = document.createElement('pre');
    detail.className = 'wv-crash-detail';

    const actions = document.createElement('div');
    actions.className = 'wv-crash-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'wv-btn';
    copyBtn.textContent = 'Copy diagnostics';
    copyBtn.onclick = () => void this.copy(this.diagnostics(this.crashError), copyBtn);

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'wv-btn wv-btn-primary';
    reloadBtn.textContent = 'Reload';
    reloadBtn.onclick = () => location.reload();

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'wv-btn';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.onclick = () => this.hideCrash();

    actions.append(copyBtn, reloadBtn, dismissBtn);
    card.append(title, msg, detail, actions);
    overlay.append(card);

    this.crash = overlay;
    this.crashTitle = title;
    this.crashMsg = msg;
    this.crashDetail = detail;
  }

  private injectStyles(): void {
    const css = `
#wv-log {
  position: fixed; right: 8px; bottom: 8px; z-index: 10000;
  width: min(560px, 92vw); height: min(300px, 45vh);
  display: flex; flex-direction: column;
  background: rgba(6, 9, 12, 0.9); color: #cdd6df;
  border: 1px solid rgba(120, 160, 180, 0.35); border-radius: 8px;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55); backdrop-filter: blur(3px);
}
#wv-log .wv-log-bar {
  display: flex; align-items: center; gap: 6px; padding: 5px 8px;
  border-bottom: 1px solid rgba(120, 160, 180, 0.25);
}
#wv-log .wv-log-title { flex: 1; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.7; }
#wv-log .wv-log-body { flex: 1; overflow-y: auto; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; }
#wv-log .wv-log-row { padding: 0; }
.wv-btn {
  font: inherit; color: #cdd6df; cursor: pointer;
  background: rgba(120, 160, 180, 0.12); border: 1px solid rgba(120, 160, 180, 0.35);
  border-radius: 5px; padding: 3px 8px;
}
.wv-btn:hover { background: rgba(120, 160, 180, 0.25); }
.wv-btn-primary { color: #06202a; background: #7fd1c4; border-color: #7fd1c4; }
#wv-crash {
  position: fixed; inset: 0; z-index: 10001;
  display: flex; align-items: center; justify-content: center;
  background: rgba(4, 5, 8, 0.82); backdrop-filter: blur(2px);
  font: 13px/1.5 system-ui, -apple-system, Segoe UI, sans-serif;
}
#wv-crash .wv-crash-card {
  width: min(680px, 92vw); max-height: 86vh; overflow: auto;
  background: #0b1116; color: #dbe3ea;
  border: 1px solid rgba(255, 122, 122, 0.5); border-radius: 12px;
  padding: 20px 22px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
}
#wv-crash.wv-notice .wv-crash-card { border-color: rgba(255, 207, 107, 0.55); }
#wv-crash .wv-crash-title { font-size: 17px; font-weight: 650; margin-bottom: 6px; }
#wv-crash .wv-crash-msg { opacity: 0.85; margin-bottom: 12px; }
#wv-crash .wv-crash-detail {
  margin: 0 0 14px; padding: 10px 12px; max-height: 42vh; overflow: auto;
  background: rgba(0, 0, 0, 0.4); border-radius: 8px;
  font: 11px/1.45 ui-monospace, Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word; color: #b9c2cc;
}
#wv-crash.wv-notice .wv-crash-detail { display: none; }
#wv-crash .wv-crash-actions { display: flex; gap: 8px; flex-wrap: wrap; }
`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }
}
