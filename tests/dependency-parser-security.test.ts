import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Keep a vulnerable parser from hanging the test worker. SIGKILL also makes
// the deadline independent of a child's signal handlers or JavaScript loop.
function expectParserProcessToPass(source: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 3_000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024,
  })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('ok')
}

describe('dependency parser security regressions', () => {
  // https://github.com/advisories/GHSA-7w5x-hrqm-74c2
  it('rejects unfinished TOML structures whose final comment has no newline', () => {
    expectParserProcessToPass(`
      import assert from 'node:assert/strict'
      import { parse, TomlError } from 'smol-toml'
      for (const input of ['a=[1 #', 'a={b=1 #']) {
        assert.throws(() => parse(input), TomlError)
      }
      assert.deepEqual(parse('a=[1] # trailing comment'), { a: [1] })
      console.log('ok')
    `)
  }, 10_000)

  // https://github.com/advisories/GHSA-2883-xcg3-v3hh
  it('counts empty YAML merge sources against the document merge budget', () => {
    expectParserProcessToPass(`
      import assert from 'node:assert/strict'
      import yaml from 'js-yaml'
      const input = 'arr: &arr [{}, {}]\\ntargets:\\n  - <<: *arr\\n  - <<: *arr\\n'
      assert.deepEqual(yaml.load(input, { maxTotalMergeKeys: 4 }).targets, [{}, {}])
      assert.throws(
        () => yaml.load(input, { maxTotalMergeKeys: 3 }),
        error => error instanceof yaml.YAMLException && /maxTotalMergeKeys/.test(error.message),
      )
      console.log('ok')
    `)
  }, 10_000)
})
