import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runGeminiExtensionCommand } from '../../client/electron/agent-integration/hosts/gemini-extension-command'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true,force:true}) })
function fixture(code: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-runner-test-')); roots.push(root)
  const executable = path.join(root,'cli'); fs.writeFileSync(executable, `#!${process.execPath}\n${code}`, {mode:0o700})
  return {root, executable, options:{cwd:root, env:{PATH:process.env.PATH!}, timeoutMs:5000}}
}
it('scopes approved source trust to a temporary file and closes stdin', async () => {
  const f = fixture(`const fs=require('fs'); console.log(JSON.stringify({cwd:process.cwd(),trust:JSON.parse(fs.readFileSync(process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH)),file:process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH,relaunch:process.env.GEMINI_CLI_NO_RELAUNCH}));process.stdin.on('end',()=>console.log('EOF'));process.stdin.resume()`)
  const result = await runGeminiExtensionCommand(f.executable,['extensions','install',f.root,'--consent'], f.options)
  expect(result.exitCode).toBe(0)
  const evidence = JSON.parse(result.stdout.split('\n')[0])
  expect(evidence.trust).toEqual({[fs.realpathSync(f.root)]:'TRUST_FOLDER'})
  expect(evidence.relaunch).toBe('true'); expect(result.stdout).toContain('EOF')
  expect(fs.existsSync(evidence.file)).toBe(false)
})
it('kills a SIGTERM-ignoring command and its descendant on timeout', async () => {
  const f = fixture(`const {spawn}=require('child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});console.log(c.pid);setInterval(()=>{},1000)`)
  const result = await runGeminiExtensionCommand(f.executable,[], {...f.options,timeoutMs:3000})
  expect(result.exitCode).toBe(1); expect(result.stderr).toContain('gemini_extension_command_timeout')
  const pid = Number(result.stdout.trim()); expect(pid).toBeGreaterThan(0)
  await new Promise(resolve=>setTimeout(resolve,100))
  expect(()=>process.kill(pid,0)).toThrow()
})
it('does not grant source trust to unapproved operations', async () => {
  const f=fixture(`console.log(process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH || 'none')`)
  expect((await runGeminiExtensionCommand(f.executable,['extensions','list'],f.options)).stdout.trim()).toBe('none')
})

import { parseExtensionList } from '../../client/electron/agent-integration/hosts/gemini-extension-adapter'
it('reads headless stderr JSON without treating suppressed output as an empty installation list', () => {
  expect(parseExtensionList('', '[DEBUG] discovery\n[\n{"name":"tidemind","isActive":true}\n]\n')).toMatchObject({ok:true,extensions:[{name:'tidemind',isActive:true}]})
  expect(parseExtensionList('')).toMatchObject({ok:false})
  expect(parseExtensionList('', '[DEBUG] nothing')).toMatchObject({ok:false})
  expect(parseExtensionList('', '[{"name":"tidemind"}]\n[]')).toMatchObject({ok:false})
  expect(parseExtensionList('', '[]\ntrailing log')).toMatchObject({ok:false})
  expect(parseExtensionList('[]')).toEqual({ok:true,extensions:[]})
})
it('preserves UTF-8 split across output chunks', async () => {
  const f=fixture(`const b=Buffer.from('中文');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30)`)
  expect((await runGeminiExtensionCommand(f.executable,[],f.options)).stdout).toBe('中文')
})
it('limits output by bytes rather than character count', async () => {
  const f=fixture(`process.stdout.write('中'.repeat(400000));setInterval(()=>{},1000)`)
  expect((await runGeminiExtensionCommand(f.executable,[],f.options)).stderr).toContain('gemini_extension_command_output_limit')
})
it('cleans same-group descendants even after a successful parent exit', async () => {
  const f=fixture(`const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);c.unref()`)
  const result=await runGeminiExtensionCommand(f.executable,[],f.options)
  expect(result.exitCode).toBe(0)
  const pid=Number(result.stdout.trim())
  await expect.poll(()=>{try{process.kill(pid,0);return true}catch{return false}}).toBe(false)
})
