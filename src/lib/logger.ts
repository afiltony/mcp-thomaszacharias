/**
 * Minimal structured JSON logger with secret redaction.
 * Writes one JSON object per line to stdout/stderr (Cloud Run forwards these to Cloud Logging).
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN = /(authorization|api[-_]?key|secret|token|password|private[-_]?key|seed|mnemonic|rpc[-_]?url)/i;

/** Values matching these patterns are masked wherever they appear. */
const secretValues = new Set<string>();
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secretValues.add(value);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') {
    let out = value;
    for (const s of secretValues) if (out.includes(s)) out = out.split(s).join('[REDACTED]');
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

let minLevel: Level = (process.env.LOG_LEVEL as Level) || 'info';
export function setLogLevel(l: Level) {
  minLevel = l;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[minLevel]) return;
  if (process.env.VITEST && level !== 'error') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields ?? {}) as object) }, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
