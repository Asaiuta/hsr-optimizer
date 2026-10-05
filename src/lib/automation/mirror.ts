/**
 * Mirror feed contract shared by the page side (event emission), the MCP relay
 * (scripts/automation-mcp.mts) and the in-app live viewer. Pure logic only — no
 * runtime dependencies — so the lazy automation install can import it freely.
 */

export type AutomationMirrorEvent = {
  /** Epoch ms when the call started. */
  ts: number,
  /** Command name ('import_scan'), 'describe', or a bridge-only tool ('hsr_start_scan'). */
  name: string,
  ok: boolean,
  errorCode?: string,
  /** Bounded error message; present when ok is false. */
  errorMessage?: string,
  durationMs: number,
  /** Bounded summaries — never the full payload. */
  input: unknown,
  data?: unknown,
}

export type AutomationMirrorBroadcast = AutomationMirrorEvent & {
  /** Assigned by the relay in arrival order. Viewers drop everything at or below their high-water mark. */
  seq: number,
}

const MAX_DEPTH = 4
const MAX_STRING = 240
const MAX_ARRAY = 6
const MAX_TOTAL = 2000

/** Reduce an arbitrary input or response to a bounded, displayable summary. */
export function summarizeAutomationValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > MAX_STRING) {
      return value.slice(0, MAX_STRING) + `…(+${value.length - MAX_STRING} chars)`
    }
    return value
  }
  if (depth >= MAX_DEPTH) return '…'
  if (Array.isArray(value)) {
    const sample = value.slice(0, MAX_ARRAY).map((item) => summarizeAutomationValue(item, depth + 1))
    if (value.length > MAX_ARRAY) sample.push(`…(${value.length} items)`)
    return sample
  }
  const summary: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) summary[key] = summarizeAutomationValue(item, depth + 1)
  if (JSON.stringify(summary).length <= MAX_TOTAL) return summary
  return `…(large object, truncated to keys: ${Object.keys(summary).slice(0, 20).join(', ')})`
}

export type MirrorFeedEntry = {
  /** Stable React key: the seq of the first event in the merge run. */
  seq: number,
  name: string,
  ok: boolean,
  errorCode?: string,
  errorMessage?: string,
  durationMs: number,
  ts: number,
  /** Consecutive calls with the same command and input merged into one row. */
  count: number,
  input: unknown,
  data?: unknown,
  /** Serialized input for consecutive-merge comparison; not displayed. */
  inputKey: string,
}

function feedInputKey(input: unknown): string {
  try {
    return JSON.stringify(input) ?? 'undefined'
  } catch {
    return 'unserializable'
  }
}

/**
 * Prepend an event as newest-first. Consecutive events with the same command,
 * input and outcome collapse into one row carrying the latest status and data.
 */
export function appendMirrorFeedEntry(entries: MirrorFeedEntry[], event: AutomationMirrorBroadcast, max = 300): MirrorFeedEntry[] {
  const inputKey = feedInputKey(event.input)
  const head = entries[0]
  if (head && head.seq <= event.seq && head.name === event.name && head.inputKey === inputKey && head.ok === event.ok && head.errorCode === event.errorCode && head.errorMessage === event.errorMessage) {
    const merged: MirrorFeedEntry = { ...head, count: head.count + 1, ts: event.ts, durationMs: event.durationMs, data: event.data }
    return [merged, ...entries.slice(1)]
  }
  const entry: MirrorFeedEntry = {
    seq: event.seq,
    name: event.name,
    ok: event.ok,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    durationMs: event.durationMs,
    ts: event.ts,
    count: 1,
    input: event.input,
    data: event.data,
    inputKey,
  }
  return [entry, ...entries].slice(0, max)
}
