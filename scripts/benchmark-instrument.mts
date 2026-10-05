import ts from 'typescript'
import { build } from 'vite'

// Instrument only an isolated diagnostic build. No production source is rewritten.
const targets: Record<string, string[]> = {
  '/lib/automation/core/request.ts': ['resolveRequest'],
  '/lib/optimization/optimizer.ts': ['getFilteredRelics'],
  '/lib/optimization/bufferPacker.ts': ['extractArrayToResults', 'cleanFloatBuffer', 'createFloatBuffer'],
  '/lib/optimization/relicSetSolver.ts': [
    'generateRelicSetSolutions',
    'generateOrnamentSetSolutions',
    'applySemiJoinReduction',
    'computeValidPermutationCount',
  ],
  '/lib/optimization/context/calculateContext.ts': ['generateContext'],
  '/lib/gpu/webgpuInternals.ts': ['initializeGpuPipeline', 'generatePipeline'],
  '/lib/gpu/injection/generateWgsl.ts': ['generateWgsl'],
  '/lib/gpu/webgpuOptimizer.ts': ['runNaiveDispatch', 'runTupleDispatch', 'outputResults'],
}
await build({
  configFile: 'vite.config.ts',
  build: { outDir: 'output/performance-suite/diagnostic-site' },
  plugins: [{
    name: 'benchmark-only-phases',
    enforce: 'pre',
    transform(source, id) {
      const path = id.replaceAll('\\', '/')
      const wanted = Object.entries(targets).find(([suffix]) => path.endsWith(suffix))?.[1]
      if (!wanted) return
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
      const edits: { offset: number, text: string }[] = []
      function visit(node: ts.Node) {
        const name = ts.isFunctionDeclaration(node)
          ? node.name?.text
          : ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
          ? node.name.text
          : undefined
        const body = ts.isFunctionDeclaration(node)
          ? node.body
          : ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer)
          ? node.initializer.body
          : undefined
        if (name && wanted!.includes(name) && body && ts.isBlock(body)) {
          const fn = ts.isFunctionDeclaration(node) ? node : ts.isPropertyAssignment(node) ? node.initializer : undefined
          const asynchronous = fn && ts.canHaveModifiers(fn) && ts.getModifiers(fn)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
          edits.push({
            offset: body.getStart(file) + 1,
            text: `\nconst __benchStart = performance.now(); try {${asynchronous ? ' return await (async () => {' : ''}\n`,
          })
          edits.push({
            offset: body.end - 1,
            text: `\n${asynchronous ? '})();' : ''}} finally { const s = (globalThis.__hsrPhases ??= {}); const p = (s[${
              JSON.stringify(name)
            }] ??= { calls: 0, totalMs: 0 }); p.calls++; p.totalMs += performance.now() - __benchStart; }\n`,
          })
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
      if (edits.length !== wanted.length * 2) throw Error(`Instrumentation target missing: ${path}`)
      for (const edit of edits.sort((a, b) => b.offset - a.offset)) source = source.slice(0, edit.offset) + edit.text + source.slice(edit.offset)
      return { code: source, map: null }
    },
  }],
  worker: {
    plugins: () => [{
      name: 'benchmark-worker-phases',
      enforce: 'pre',
      transform(source, id) {
        if (!id.replaceAll('\\', '/').endsWith('/lib/worker/optimizerWorker.ts')) return
        const patches = [
          ['  initializeContextConditionals(context)', '  const __prepareStart = performance.now()\n  initializeContextConditionals(context)'],
          ['  for (let col = 0; col < limit; col++) {', '  const __searchStart = performance.now()\n  for (let col = 0; col < limit; col++) {'],
          [
            '  self.postMessage({',
            '  const __searchEnd = performance.now()\n  self.postMessage({\n    __benchWorker: { prepareMs: __searchStart - __prepareStart, computeMs: __searchEnd - __searchStart, width: limit, passed: passCount },',
          ],
        ]
        for (const [before, after] of patches) {
          if (!source.includes(before)) throw Error(`Worker instrumentation target missing: ${before}`)
          source = source.replace(before, after)
        }
        return { code: source, map: null }
      },
    }],
  },
})
