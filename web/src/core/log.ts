/**
 * wAIver — structured logging + a diagnostics ring buffer.
 *
 * One tiny layer that replaces scattered `console.*` calls so failures are
 * (a) leveled and categorized, (b) captured in a ring buffer we can dump on any
 * device — the phone/LAN testing this project relies on has no reachable
 * devtools console — and (c) rate-limited, so a per-frame failure can't flood.
 *
 * Usage:
 *   const L = logger('world');
 *   L.info('generated', chunks, 'chunks');
 *   L.once('nan', 'warn', 'NaN in mesh');   // logs the key at most once
 *   L.throttle('slow', 1000, 'warn', ...);  // at most once per 1000ms
 *
 * Level is resolved once at boot: ?log=<level> in the URL, then
 * localStorage['waiver.logLevel'], then the dev/prod default from config. It can
 * be changed live with setLogLevel() (also persisted to localStorage).
 */
import { Debug } from '../config';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type EmitLevel = Exclude<LogLevel, 'silent'>;

/** Higher number = more verbose. A message emits when its level ≤ activeLevel. */
const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

export interface LogEntry {
  /** ms since page load (performance.now, rounded). */
  t: number;
  level: EmitLevel;
  cat: string;
  msg: string;
}

type Listener = (e: LogEntry) => void;

const buffer: LogEntry[] = [];
const listeners = new Set<Listener>();
const onceKeys = new Set<string>();
const throttleAt = new Map<string, number>();

function isLevel(x: unknown): x is LogLevel {
  return typeof x === 'string' && x in ORDER;
}

function resolveInitialLevel(): LogLevel {
  // 1) URL flag wins — cheapest way to crank verbosity on a phone (?log=trace).
  try {
    const q = new URLSearchParams(location.search).get('log');
    if (isLevel(q)) return q;
  } catch {
    /* no location (non-browser context) — fall through */
  }
  // 2) Persisted preference.
  try {
    const ls = localStorage.getItem('waiver.logLevel');
    if (isLevel(ls)) return ls;
  } catch {
    /* storage blocked — fall through */
  }
  // 3) Build default.
  const def = import.meta.env.DEV ? Debug.logLevelDev : Debug.logLevelProd;
  return isLevel(def) ? def : 'warn';
}

let activeLevel: LogLevel = resolveInitialLevel();

/** Render args to a flat string for the ring buffer / overlay. */
function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

const CONSOLE: Record<EmitLevel, (...a: unknown[]) => void> = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: (console.debug ?? console.log).bind(console),
  trace: (console.debug ?? console.log).bind(console),
};

function emit(level: EmitLevel, cat: string, args: unknown[]): void {
  if (ORDER[level] > ORDER[activeLevel]) return;
  const entry: LogEntry = {
    t: Math.round(performance.now()),
    level,
    cat,
    msg: fmt(args),
  };
  buffer.push(entry);
  const overflow = buffer.length - Debug.ringBufferSize;
  if (overflow > 0) buffer.splice(0, overflow);
  // Pass raw args to the console so objects/Errors stay inspectable there.
  CONSOLE[level](`[${cat}]`, ...args);
  for (const l of listeners) {
    try {
      l(entry);
    } catch {
      /* a listener must never break logging */
    }
  }
}

export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  /** Log `key` at most once for the lifetime of the page. */
  once(key: string, level: EmitLevel, ...args: unknown[]): void;
  /** Log `key` at most once per `ms`. For anything reachable from frame(). */
  throttle(key: string, ms: number, level: EmitLevel, ...args: unknown[]): void;
}

export function logger(cat: string): Logger {
  return {
    error: (...a) => emit('error', cat, a),
    warn: (...a) => emit('warn', cat, a),
    info: (...a) => emit('info', cat, a),
    debug: (...a) => emit('debug', cat, a),
    trace: (...a) => emit('trace', cat, a),
    once(key, level, ...a) {
      const k = `${cat}:${key}`;
      if (onceKeys.has(k)) return;
      onceKeys.add(k);
      emit(level, cat, a);
    },
    throttle(key, ms, level, ...a) {
      const k = `${cat}:${key}`;
      const now = performance.now();
      const last = throttleAt.get(k) ?? -Infinity;
      if (now - last < ms) return;
      throttleAt.set(k, now);
      emit(level, cat, a);
    },
  };
}

export function setLogLevel(level: LogLevel): void {
  if (!isLevel(level)) {
    logger('log').warn(`unknown level "${String(level)}" (silent|error|warn|info|debug|trace)`);
    return;
  }
  activeLevel = level;
  try {
    localStorage.setItem('waiver.logLevel', level);
  } catch {
    /* storage blocked — level still applies for this session */
  }
  logger('log').info(`level = ${level}`);
}

export function getLogLevel(): LogLevel {
  return activeLevel;
}

/** Live view of the ring buffer (do not mutate). */
export function getLogBuffer(): readonly LogEntry[] {
  return buffer;
}

/** Subscribe to new entries (for the on-screen panel). Returns an unsubscribe. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function formatEntry(e: LogEntry): string {
  const secs = (e.t / 1000).toFixed(2).padStart(7, ' ');
  return `${secs}s ${e.level.toUpperCase().padEnd(5)} [${e.cat}] ${e.msg}`;
}

/** The whole ring buffer as copyable text — window.waiver.dumpLogs(). */
export function dumpLogs(): string {
  return buffer.map(formatEntry).join('\n');
}

/**
 * Programmer-error guard: logs `error` and throws when `cond` is falsy.
 * Use for invariants that indicate a bug, not for expected runtime failures.
 */
export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    logger('assert').error(msg);
    throw new Error(`Assertion failed: ${msg}`);
  }
}

/** Alias — reads better at call sites documenting a design invariant. */
export function invariant(cond: unknown, msg: string): asserts cond {
  assert(cond, msg);
}
