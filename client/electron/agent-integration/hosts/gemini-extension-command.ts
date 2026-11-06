import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GeminiExtensionAdapterDependencies, GeminiExtensionCommandResult } from './gemini-extension-adapter'

/** Run only the already approved CLI operation, with no interactive stdin. */
export const runGeminiExtensionCommand: GeminiExtensionAdapterDependencies['run'] = async (executable, args, options) => {
  let trustDirectory: string | undefined
  const env = { ...options.env, GEMINI_CLI_NO_RELAUNCH: 'true' }
  let cwd = options.cwd
  try {
    // --consent does not cover Gemini's separate local-source folder prompt.
    // Scope trust to this approved source and this command; never trust HOME or
    // write the user's persistent trustedFolders.json.
    if (args[0] === 'extensions' && args[1] === 'install' && args.includes('--consent')) {
      if (fs.lstatSync(args[2]).isSymbolicLink()) throw new Error('gemini_extension_source_symlink')
      cwd = fs.realpathSync(args[2])
      trustDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-gemini-trust-'))
      const trustFile = path.join(trustDirectory, 'trustedFolders.json')
      fs.writeFileSync(trustFile, JSON.stringify({ [cwd]: 'TRUST_FOLDER' }), { mode: 0o600 })
      Object.assign(env, { GEMINI_CLI_TRUSTED_FOLDERS_PATH: trustFile })
    }
    return await new Promise<GeminiExtensionCommandResult>(resolve => {
      let stdout = '', stderr = '', failure: string | undefined
      let outputBytes = 0
      let timeoutDrain: ReturnType<typeof setTimeout> | undefined
      // Gemini 0.39 suppresses list JSON in headless mode unless debug is enabled.
      const commandArgs = args[0] === 'extensions' && args[1] === 'list'
        ? [...args, '--debug'] : [...args]
      const child = spawn(executable, commandArgs, {
        cwd, env, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const kill = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL') }
      }
      const timer = setTimeout(() => {
        failure = 'gemini_extension_command_timeout'; kill()
        // A detached descendant must not hold our pipes open forever.
        child.stdout.destroy(); child.stderr.destroy()
        timeoutDrain = setTimeout(() => resolve({exitCode:1,stdout,stderr:`${failure}\n${stderr}`}), 1000)
      }, options.timeoutMs)
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      const collect = (chunk: string, stream: 'stdout' | 'stderr') => {
        outputBytes += Buffer.byteLength(chunk)
        if (stream === 'stdout') stdout += chunk
        else stderr += chunk
        if (outputBytes > 1024 * 1024) {
          stdout = stdout.slice(0, 512 * 1024); stderr = stderr.slice(0, 512 * 1024)
          failure = 'gemini_extension_command_output_limit'; kill()
        }
      }
      child.stdout.on('data', chunk => collect(chunk, 'stdout'))
      child.stderr.on('data', chunk => collect(chunk, 'stderr'))
      child.once('error', error => {
        clearTimeout(timer)
        resolve({ exitCode: 1, stdout, stderr: error.message })
      })
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(timeoutDrain)
        kill()
        resolve({ exitCode: failure ? 1 : code ?? 1, stdout, stderr: failure ? `${failure}\n${stderr}` : stderr })
      })
    })
  } finally {
    if (trustDirectory) fs.rmSync(trustDirectory, { recursive: true, force: true })
  }
}
