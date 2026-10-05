// Exact contract for the audited 8004 / Amber / E6 TALENT_SHIELD kernel.
// See scripts/shield-pruning/proof.md. Unrecognized shaders use ordinary enumeration.
export const AUDITED_SHADER_SHA256 = '767d37c72bfeb4320af346d529e0610cf969243f36a1ad121da939ee36f184ec'
export const PARTS = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope'] as const
export type Piece = { defP: number, def: number, set: number }
export type Block = { prefix: number[], offset: number, size: number, upper: number }
export type Bound = { slots: Piece[][], sizes: number[], total: number, upper: (prefix: number[]) => number }

export function normalizeShader(shader: string): string {
  return shader.replaceAll('\r\n', '\n').replace(
    /const (lSize|pSize|fSize|bSize|gSize|hSize|BLOCK_SIZE) = \d+;/g,
    'const $1 = SIZE;',
  )
}

export async function shaderDigest(shader: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeShader(shader)))
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('')
}

export async function qualifyShieldBound(shader: string, matrix: Float32Array, precomputed: Float32Array, sizes: number[]): Promise<Bound | undefined> {
  if (!supportedBuffers(matrix, precomputed, sizes) || await shaderDigest(shader) !== AUDITED_SHADER_SHA256) return undefined
  return createBound(matrix, sizes)
}

export function supportedBuffers(matrix: Float32Array, precomputed: Float32Array, sizes: number[]): boolean {
  if (sizes.length !== 6 || sizes.some((n) => !Number.isInteger(n) || n < 1 || n > 1_000_000)) return false
  if (!Number.isSafeInteger(sizes.reduce((a, b) => a * b, 1))) return false
  if (matrix.length !== sizes.reduce((a, b) => a + b, 0) * 24 || precomputed.length !== 243) return false
  // No tiny values, infinities, negative modifiers, or overflow in the audited dependency cone.
  const finiteNormal = (x: number) => Number.isFinite(x) && Math.abs(x) <= 1_000_000 && (x === 0 || Math.abs(x) >= 2 ** -32)
  if (!precomputed.every(finiteNormal)) return false
  const action = precomputed.subarray(162)
  if (action[2] !== Math.fround(0.62) || action[6] !== 0 || action[51] !== 0 || action[60] !== 0) return false
  let row = 0
  for (let slot = 0; slot < 6; slot++) {
    for (let i = 0; i < sizes[slot]; i++, row++) {
      for (let stat = 0; stat < 22; stat++) {
        const x = matrix[row * 24 + stat]
        if (!finiteNormal(x) || x < 0) return false
      }
      const set = matrix[row * 24 + 22]
      if (!Number.isInteger(set) || set < 0 || set >= (slot < 4 ? 34 : 28)) return false
    }
  }
  return true
}

// See proof.md: at most 64 positive f32 rounding steps and 64 binary64 steps.
// 1 + 2^-15 exceeds (1 + 2^-23)^64 / (1 - 2^-53)^65. This is a derived
// rounding envelope, not an empirically selected score tolerance.
export const ROUNDING_ENVELOPE = 1 + 2 ** -15
const f = Math.fround

export function createBound(matrix: Float32Array, sizes: number[]): Bound {
  let start = 0
  const slots = sizes.map((size) => {
    const rows = Array.from({ length: size }, (_, i) => ({
      defP: matrix[(start + i) * 24 + 2],
      def: matrix[(start + i) * 24 + 6],
      set: matrix[(start + i) * 24 + 22],
    }))
    start += size
    return rows
  })
  const maxP = slots.map((rows) => rows.reduce((max, r) => Math.max(max, r.defP), 0))
  const maxD = slots.map((rows) => rows.reduce((max, r) => Math.max(max, r.def), 0))
  const has = slots.map((rows) => new Set(rows.map((r) => r.set)))
  const total = sizes.reduce((a, b) => a * b, 1)
  function upper(prefix: number[]): number {
    let defP = 0, def = 0, knight = 0, recluse = 0, belobog = 0
    for (let slot = 0; slot < 6; slot++) {
      const r = slot < prefix.length ? slots[slot][prefix[slot]] : undefined
      defP += r ? r.defP : maxP[slot]
      def += r ? r.def : maxD[slot]
      const possible = (set: number) => r ? r.set === set : has[slot].has(set)
      if (slot < 4) {
        knight += +possible(2)
        recluse += +possible(27)
      } else belobog += +possible(3)
    }
    // Independent maxima may be incompatible. That only makes the bound looser.
    const setDef = f(0.15) * (+(knight >= 2) + +(belobog === 2))
    const boost = Math.max(knight === 4 ? f(0.2) : 0, recluse === 4 ? f(0.1) + f(0.12) : recluse >= 2 ? f(0.1) : 0)
    // Belobog is allowed to activate whenever the pair is possible, regardless of EHR.
    const combatDef = def + 937.125 * (1 + defP + f(0.35) + f(0.32))
      + 937.125 * setDef + f(0.62) * 937.125 + (belobog === 2 ? f(140.56875) : 0)
    return (f(0.064) * combatDef + 89) * (1 + boost) * ROUNDING_ENVELOPE
  }
  return { slots, sizes, total, upper }
}

// A non-full queue has no threshold. Equality always stays on the exhaustive path.
export function canPrune(upper: number, threshold: number, full: boolean): boolean {
  return full && Number.isFinite(upper) && Number.isFinite(threshold) && upper < threshold
}

export function children(bound: Bound, parent: Block): Block[] {
  const depth = parent.prefix.length
  const size = parent.size / bound.sizes[depth]
  return Array.from({ length: bound.sizes[depth] }, (_, index) => {
    const prefix = [...parent.prefix, index]
    return { prefix, offset: parent.offset + index * size, size, upper: bound.upper(prefix) }
  }).sort((a, b) => b.upper - a.upper || a.offset - b.offset)
}

// Independently certify the complement of successfully evaluated GPU ranges.
// The final Kth score is legitimate only after K unique candidates have been audited.
export function certifyCoverage(bound: Bound, evaluated: { offset: number, size: number }[], cutoff: number) {
  if (!Number.isFinite(cutoff)) throw new Error('Invalid certificate cutoff')
  const ranges: { start: number, end: number }[] = []
  let evaluatedCount = 0
  for (const r of [...evaluated].sort((a, b) => a.offset - b.offset)) {
    if (!Number.isSafeInteger(r.offset) || !Number.isSafeInteger(r.size) || r.size <= 0 || r.offset < 0 || r.offset + r.size > bound.total) {
      throw new Error('Invalid evaluated interval')
    }
    const last = ranges.at(-1)
    if (last && r.offset < last.end) throw new Error('Overlapping evaluated intervals')
    if (last && r.offset === last.end) last.end += r.size
    else ranges.push({ start: r.offset, end: r.offset + r.size })
    evaluatedCount += r.size
  }
  let certified = 0, nodes = 0
  function visit(prefix: number[], offset: number, size: number) {
    nodes++
    let lo = 0, hi = ranges.length
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (ranges[mid].end <= offset) lo = mid + 1
      else hi = mid
    }
    const range = ranges[lo]
    if (range && range.start <= offset && range.end >= offset + size) return
    if (!range || range.start >= offset + size) {
      if (canPrune(bound.upper(prefix), cutoff, true)) {
        certified += size
        return
      }
    }
    if (prefix.length === 6) throw new Error(`Uncertified omitted index ${offset}`)
    const count = bound.sizes[prefix.length], childSize = size / count
    for (let i = 0; i < count; i++) visit([...prefix, i], offset + i * childSize, childSize)
  }
  visit([], 0, bound.total)
  if (certified + evaluatedCount !== bound.total) throw new Error('Certificate coverage mismatch')
  return { evaluated: evaluatedCount, certified, total: bound.total, nodes }
}
