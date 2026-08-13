import path from 'node:path'
import { pathToFileURL } from 'node:url'

function replaceExactlyOnce(source, expected, replacement, label) {
  const first = source.indexOf(expected)
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`could not uniquely materialize ${label}`)
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length)
}

export function materializeMetabolismPerformanceRunner(source, repoRoot) {
  const canonicalRepoRoot = path.resolve(repoRoot)
  let materialized = replaceExactlyOnce(
    source,
    "const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)",
    `const repoRoot = ${JSON.stringify(canonicalRepoRoot)}`,
    'repository root',
  )
  materialized = replaceExactlyOnce(
    materialized,
    'const require = createRequire(import.meta.url)',
    `const require = createRequire(${JSON.stringify(path.join(canonicalRepoRoot, 'package.json'))})`,
    'dependency resolver',
  )
  materialized = replaceExactlyOnce(
    materialized,
    "if (packaged) {\n    throw new Error('packaged performance is only available through run-packaged-metabolism-worker-performance.mjs')\n  }",
    "if (packaged && !skipBuild) { throw new Error('trusted packaged run requires the prepared harness') }",
    'one-shot packaged guard',
  )
  materialized = replaceExactlyOnce(
    materialized,
    "import { evaluateMetabolismPerformanceResult } from './evaluate-metabolism-performance-result.mjs'",
    `import { evaluateMetabolismPerformanceResult } from ${JSON.stringify(pathToFileURL(path.join(canonicalRepoRoot, 'scripts', 'evaluate-metabolism-performance-result.mjs')).href)}`,
    'performance evaluator',
  )
  materialized = replaceExactlyOnce(
    materialized,
    "import { createCpuUtilizationSampler } from './cpu-utilization-sampler.mjs'",
    `import { createCpuUtilizationSampler } from ${JSON.stringify(pathToFileURL(path.join(canonicalRepoRoot, 'scripts', 'cpu-utilization-sampler.mjs')).href)}`,
    'CPU utilization sampler',
  )
  return materialized
}
