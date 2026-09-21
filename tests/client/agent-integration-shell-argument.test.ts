import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shellArgument } from '../../client/electron/agent-integration/shell-argument'
import { QWEN_CODE_LIFECYCLE_SPEC } from '../../client/electron/agent-integration/hosts/json-lifecycle-hook-adapter'
import type { AdapterOperationContext } from '../../client/electron/agent-integration/types'

describe('host hook literal shell arguments', () => {
  it('round-trips spaces, quotes, expansions, newlines and Unicode through the real POSIX shell', () => {
    const values = ['', 'path with spaces', "O'Brien", '$(printf INJECTED)', '`printf INJECTED`', '$HOME', 'line\nnext', '\\backslash', '中文']
    const output = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${values.map(shellArgument).join(' ')}`])
    expect(output.toString().split('\0').slice(0, -1)).toEqual(values)
    expect(() => shellArgument('a\0b')).toThrow('shell_argument_contains_nul')
  })

  it('keeps generated Qwen hook executable and Skill paths literal', () => {
    const root = "/tmp/Tide Mind's $(printf INJECTED) `printf EXPANDED`"
    const context = {
      runtime: { shimPath: `${root}/tm-node`, hookScriptPath: `${root}/hook.cjs`, preCompactScriptPath: `${root}/pre.cjs` },
      installation: { canonicalConfigRoot: `${root}/.qwen` }, agentId: 'eb_test', activityGenerationToken: 'gen',
    } as AdapterOperationContext
    const entry = QWEN_CODE_LIFECYCLE_SPEC.events(context)[0].entry as { hooks: Array<{ command: string }> }
    const output = execFileSync('/bin/sh', ['-c', `set -- ${entry.hooks[0].command}; printf '%s\\0' "$@"`]).toString().split('\0')
    expect(output.slice(0, 2)).toEqual([context.runtime.shimPath, context.runtime.hookScriptPath])
    expect(output[output.indexOf('--skill-path') + 1]).toBe(`${root}/.qwen/skills/tidemind/SKILL.md`)
  })
})
