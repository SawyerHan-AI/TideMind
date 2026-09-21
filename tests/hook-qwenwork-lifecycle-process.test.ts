import { execFile, spawn, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Consecutive spawnSync calls can starve Vitest's worker IPC for longer than
// its RPC deadline even when every individual process meets its own timeout.
// Keep the real process, input, exit status and 15s budget, but yield for IPC.
function runProcess(
  executable: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding & { input: string },
): Promise<{ status: number; stdout: string; stderr: string }> {
  const { input, ...processOptions } = options
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, processOptions, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) {
        reject(error)
        return
      }
      resolve({ status: error?.code ?? 0, stdout, stderr })
    })
    child.stdin?.on('error', reject)
    child.stdin?.end(input)
  })
}

describe('QwenWork lifecycle physical process contract', { timeout: 30_000 }, () => {
  let isolatedHome: string
  let skillPath: string
  let skillSha256: string

  beforeAll(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwenwork-hook-process-'))
    skillPath = path.join(isolatedHome, 'SKILL.md')
    fs.writeFileSync(skillPath, `---\nname: tidemind-test\n---\n\nQWENWORK_SKILL_SENTINEL\n`)
    skillSha256 = createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex')
  })

  afterAll(() => fs.rmSync(isolatedHome, { recursive: true, force: true }))

  function run(event: 'SessionStart' | 'PreCompact' | 'SessionEnd', payload: object) {
    return runProcess(
      path.resolve('node_modules/.bin/tsx'),
      [
        path.resolve('src/hook-qwenwork-lifecycle.ts'),
        '--event', event,
        '--agent-id', 'eb_qwenwork_process',
        '--skill-path', skillPath,
        '--skill-sha256', skillSha256,
        '--tool', 'qwenwork',
        '--activity-generation-token', 'generation-process-test',
      ],
      {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          HOME: isolatedHome,
          XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
          XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
        },
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 15_000,
      },
    )
  }

  it('injects prepared/skill context into a SessionStart JSON result', async () => {
    const result = await run('SessionStart', {
      hook_event_name: 'SessionStart',
      session_id: 'session-start-1',
      source: 'startup',
      cwd: isolatedHome,
    })
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(output.hookSpecificOutput.additionalContext).toContain('QWENWORK_SKILL_SENTINEL')
    expect(result.stdout.trim().startsWith('{')).toBe(true)
  })

  it('delivers fallback context but records no recognition attempt after Skill hash drift', async () => {
    fs.writeFileSync(skillPath, 'DRIFTED_UNTRUSTED_SKILL\n')
    try {
      const result = await run('SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'session-drift-1',
        source: 'startup',
        cwd: isolatedHome,
      })
      expect(result.status).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output.hookSpecificOutput.additionalContext).toContain('完整性校验失败')
      expect(output.hookSpecificOutput.additionalContext).not.toContain('DRIFTED_UNTRUSTED_SKILL')
      expect(result.stderr).toContain('qwenwork_hook_skill_hash_mismatch')
      expect(result.stderr).not.toContain('activity evidence')
    } finally {
      fs.writeFileSync(skillPath, `---\nname: tidemind-test\n---\n\nQWENWORK_SKILL_SENTINEL\n`)
    }
  })

  it('delivers fallback context but records no recognition attempt when Skill cannot be read', async () => {
    fs.renameSync(skillPath, `${skillPath}.missing`)
    try {
      const result = await run('SessionStart', {
        hook_event_name: 'SessionStart',
        session_id: 'session-read-failure-1',
        source: 'startup',
        cwd: isolatedHome,
      })
      expect(result.status).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output.hookSpecificOutput.additionalContext).toContain('读取或完整性校验失败')
      expect(result.stderr).toContain('skill unavailable')
      expect(result.stderr).not.toContain('activity evidence')
    } finally {
      fs.renameSync(`${skillPath}.missing`, skillPath)
    }
  })

  it('injects the Tide Mind preservation instruction before compaction', async () => {
    const result = await run('PreCompact', {
      hook_event_name: 'PreCompact',
      session_id: 'session-compact-1',
      trigger: 'auto',
      custom_instructions: 'untrusted host content',
      cwd: isolatedHome,
    })
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreCompact' })
    expect(output.hookSpecificOutput.additionalContext).toContain('brain_digest')
    expect(output.hookSpecificOutput.additionalContext).not.toContain('untrusted host content')
  })

  it('emits an empty JSON success document for SessionEnd', async () => {
    const result = await run('SessionEnd', {
      hook_event_name: 'SessionEnd',
      session_id: 'session-end-1',
      reason: 'logout',
      cwd: isolatedHome,
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({})
  })

  it('fails closed on a mismatched host event without emitting raw text', async () => {
    const result = await run('PreCompact', {
      hook_event_name: 'SessionStart',
      session_id: 'session-mismatch',
      source: 'startup',
    })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({})
    expect(result.stderr).toContain('qwenwork_hook_event_mismatch')
  })

  it('refuses to manufacture unbound lifecycle evidence without a generation token', async () => {
    const result = await runProcess(
      path.resolve('node_modules/.bin/tsx'),
      [
        path.resolve('src/hook-qwenwork-lifecycle.ts'),
        '--event', 'SessionEnd',
        '--agent-id', 'eb_qwenwork_process',
        '--tool', 'qwenwork',
      ],
      {
        cwd: path.resolve('.'),
        env: { ...process.env, HOME: isolatedHome },
        input: JSON.stringify({
          hook_event_name: 'SessionEnd',
          session_id: 'session-unbound',
          reason: 'logout',
        }),
        encoding: 'utf8',
        timeout: 15_000,
      },
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({})
    expect(result.stderr).toContain('qwenwork_hook_activity_generation_token_missing')
  })

  it('refuses SessionStart without the projection-frozen Skill hash', async () => {
    const result = await runProcess(
      path.resolve('node_modules/.bin/tsx'),
      [
        path.resolve('src/hook-qwenwork-lifecycle.ts'),
        '--event', 'SessionStart',
        '--agent-id', 'eb_qwenwork_process',
        '--skill-path', skillPath,
        '--tool', 'qwenwork',
        '--activity-generation-token', 'generation-process-test',
      ],
      {
        cwd: path.resolve('.'),
        env: { ...process.env, HOME: isolatedHome },
        input: JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: 'session-unhashed',
          source: 'startup',
        }),
        encoding: 'utf8',
        timeout: 15_000,
      },
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({})
    expect(result.stderr).toContain('qwenwork_hook_skill_sha256_missing')
    expect(result.stderr).not.toContain('activity evidence')
  })

  it('does not record activity when the real stdout pipe fails before delivery', async () => {
    const child = spawn(
      path.resolve('node_modules/.bin/tsx'),
      [
        path.resolve('src/hook-qwenwork-lifecycle.ts'),
        '--event', 'PreCompact',
        '--agent-id', 'eb_qwenwork_process',
        '--tool', 'qwenwork',
        '--activity-generation-token', 'generation-process-test',
      ],
      {
        cwd: path.resolve('.'),
        env: { ...process.env, HOME: isolatedHome },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const stderr: Buffer[] = []
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.stdout.destroy()
    child.stdin.end(JSON.stringify({
      hook_event_name: 'PreCompact',
      session_id: 'session-epipe',
      trigger: 'manual',
      cwd: isolatedHome,
    }))
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const diagnostics = Buffer.concat(stderr).toString('utf8')
    expect(result.code === 0 && result.signal === null).toBe(false)
    expect(diagnostics).toMatch(/fatal error.*(?:EPIPE|write)/u)
    expect(diagnostics).not.toContain('activity evidence')
  })
})
