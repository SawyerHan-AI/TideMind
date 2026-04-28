import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  parseAgentCreate,
  parseAgentUpdate,
  parseConfigFileName,
  parseEditNodeArgs,
  parseExportScope,
  parseExternalUrl,
  parseFeedbackArgs,
  parseFeedbackSignal,
  parseListArchivedOpts,
  parseNodeId,
  parseNodesListFilter,
  parseNoteSourceCreate,
  parseNoteSourceId,
  parseNoteSourcePath,
  parseNoteSourceTest,
  parseNoteSourceUpdate,
  parseOptionalBoolean,
  parsePluginClientType,
  parsePluginGenerateInput,
  parseRequiredBoolean,
  parseSaveFileArgs,
  parseSearchLimit,
  parseSearchQuery,
  parseTagText,
} from '../../client/electron/ipc/_schemas.js';

describe('ipc schema helpers', () => {
  it('accepts valid note source create payloads and trims user text', () => {
    const parsed = parseNoteSourceCreate({
      name: '  Vault  ',
      toolType: 'obsidian',
      path: '  ~/Notes  ',
      pollInterval: 30,
    });

    // path 现在会通过 parseNoteSourcePath 展开 ~ 并 resolve 到绝对路径，
    // 这是 create/update/test 共用的路径白名单一部分（防止 renderer 用 . / ..
    // 绕过白名单或写入相对路径让后续 fs.readdir 误吞）。
    expect(parsed).toEqual({
      ok: true,
      data: {
        name: 'Vault',
        toolType: 'obsidian',
        path: `${os.homedir()}/Notes`,
        pollInterval: 30,
      },
    });
  });

  it('rejects malformed note source create payloads before DB writes', () => {
    const parsed = parseNoteSourceCreate({
      name: '',
      toolType: 'unknown',
      path: '',
      pollInterval: 0,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.error).toBe('invalid_arguments');
      expect(parsed.error.details).toEqual([
        'name is required',
        'toolType is invalid',
        'path is required',
        'pollInterval must be between 1 and 86400 seconds',
      ]);
    }
  });

  it('rejects empty IDs and empty updates', () => {
    expect(parseNoteSourceId('   ')).toMatchObject({
      ok: false,
      error: { error: 'invalid_arguments', details: ['id is required'] },
    });
    expect(parseNoteSourceUpdate({})).toMatchObject({
      ok: false,
      error: { error: 'invalid_arguments', details: ['updates cannot be empty'] },
    });
  });

  it('validates note source test and optional boolean arguments', () => {
    expect(parseNoteSourceTest('logseq', '~/Graph')).toEqual({
      ok: true,
      data: { toolType: 'logseq', testPath: '~/Graph' },
    });
    expect(parseOptionalBoolean(false, 'includeArchived')).toEqual({ ok: true, data: false });
    expect(parseOptionalBoolean('yes', 'includeArchived')).toMatchObject({
      ok: false,
      error: { details: ['includeArchived must be a boolean'] },
    });
  });

  it('validates external URLs and required booleans', () => {
    expect(parseExternalUrl('https://tidemind.ai/path')).toEqual({
      ok: true,
      data: 'https://tidemind.ai/path',
    });
    expect(parseExternalUrl('file:///etc/passwd')).toMatchObject({
      ok: false,
      error: { details: ['url protocol must be http or https'] },
    });
    expect(parseRequiredBoolean(true, 'enabled')).toEqual({ ok: true, data: true });
    expect(parseRequiredBoolean('true', 'enabled')).toMatchObject({
      ok: false,
      error: { details: ['enabled must be a boolean'] },
    });
  });

  it('validates export scope and save-file arguments', () => {
    expect(parseExportScope({ tag: '  ai  ', after: '', before: '2026-04-27' })).toEqual({
      ok: true,
      data: { tag: 'ai', before: '2026-04-27' },
    });
    expect(parseExportScope({ tag: 42 })).toMatchObject({
      ok: false,
      error: { details: ['tag must be a string'] },
    });
    expect(parseSaveFileArgs('body', 'export.md')).toEqual({
      ok: true,
      data: { content: 'body', defaultName: 'export.md' },
    });
    expect(parseSaveFileArgs('body', '../export.md')).toMatchObject({
      ok: false,
      error: { details: ['defaultName must be a file name, not a path'] },
    });
  });

  it('rejects unsafe config file names', () => {
    expect(parseConfigFileName('learning3')).toEqual({ ok: true, data: 'learning3' });
    expect(parseConfigFileName('temporal-crystal')).toEqual({ ok: true, data: 'temporal-crystal' });
    expect(parseConfigFileName('..')).toMatchObject({
      ok: false,
      error: { details: ['name must be a safe file name'] },
    });
    expect(parseConfigFileName('.hidden')).toMatchObject({
      ok: false,
      error: { details: ['name must be a safe file name'] },
    });
  });

  it('validates plugin generation and client type arguments', () => {
    expect(parsePluginGenerateInput({
      agentId: 'eb_1234abcd',
      agentName: 'Research Agent',
      clientType: 'codex',
    })).toEqual({
      ok: true,
      data: {
        agentId: 'eb_1234abcd',
        agentName: 'Research Agent',
        clientType: 'codex',
      },
    });
    expect(parsePluginGenerateInput({ agentId: '../../x', agentName: 'Bad' })).toMatchObject({
      ok: false,
      error: { error: 'invalid_arguments' },
    });
    expect(parsePluginClientType('bad-client')).toMatchObject({
      ok: false,
      error: { details: ['toolType is invalid'] },
    });
  });

  it('validates agent create and update payloads', () => {
    expect(parseAgentCreate({ name: 'Claude', tool_type: 'claude-code' })).toEqual({
      ok: true,
      data: { name: 'Claude', tool_type: 'claude-code' },
    });
    expect(parseAgentUpdate({ name: ' Codex ', tool_type: 'codex' })).toEqual({
      ok: true,
      data: { name: 'Codex', tool_type: 'codex' },
    });
    expect(parseAgentUpdate({})).toMatchObject({
      ok: false,
      error: { details: ['params cannot be empty'] },
    });
  });

  it('rejects external URLs that point at private / localhost / userinfo', () => {
    expect(parseExternalUrl('http://localhost/x')).toMatchObject({ ok: false });
    expect(parseExternalUrl('http://my.localhost/x')).toMatchObject({ ok: false });
    expect(parseExternalUrl('http://service.local/x')).toMatchObject({ ok: false });
    expect(parseExternalUrl('http://127.0.0.1/x')).toMatchObject({ ok: false });
    expect(parseExternalUrl('http://10.0.0.5/x')).toMatchObject({ ok: false });
    expect(parseExternalUrl('http://172.16.0.1/x')).toMatchObject({ ok: false });
    expect(parseExternalUrl('http://192.168.1.1/x')).toMatchObject({ ok: false });
    expect(parseExternalUrl('http://169.254.169.254/latest/meta-data/')).toMatchObject({ ok: false });
    expect(parseExternalUrl('http://[::1]/x')).toMatchObject({ ok: false });
    expect(parseExternalUrl('http://[fe80::1]/x')).toMatchObject({ ok: false });
    expect(parseExternalUrl('https://attacker@evil.com/x')).toMatchObject({
      ok: false,
      error: { details: ['url must not contain credentials'] },
    });
    // 公网正常域名仍放行
    expect(parseExternalUrl('https://tidemind.ai/x')).toMatchObject({ ok: true });
  });

  it('validates node IDs as URL-safe nanoid alphabet', () => {
    expect(parseNodeId('abc123_-XYZ')).toEqual({ ok: true, data: 'abc123_-XYZ' });
    expect(parseNodeId('../../etc')).toMatchObject({ ok: false });
    expect(parseNodeId('a b')).toMatchObject({ ok: false });
    expect(parseNodeId('')).toMatchObject({ ok: false });
    expect(parseNodeId(42)).toMatchObject({ ok: false });
  });

  it('validates feedback signal range', () => {
    expect(parseFeedbackSignal(1)).toEqual({ ok: true, data: 1 });
    expect(parseFeedbackSignal(-2)).toEqual({ ok: true, data: -2 });
    expect(parseFeedbackSignal(3)).toMatchObject({ ok: false });
    expect(parseFeedbackSignal(0.5)).toMatchObject({ ok: false });
    expect(parseFeedbackSignal('1')).toMatchObject({ ok: false });
  });

  it('validates editNode args end-to-end', () => {
    expect(parseEditNodeArgs('node1', 'content', null, 'why')).toMatchObject({
      ok: true,
      data: { nodeId: 'node1', newContent: 'content', newTitle: null, reason: 'why' },
    });
    expect(parseEditNodeArgs('../etc', 'x', null, 'r')).toMatchObject({ ok: false });
    expect(parseEditNodeArgs('n1', 42, null, 'r')).toMatchObject({
      ok: false,
      error: { details: ['newContent must be a string'] },
    });
    expect(parseEditNodeArgs('n1', 'c', { obj: true }, 'r')).toMatchObject({
      ok: false,
      error: { details: ['newTitle must be a string or null'] },
    });
    expect(parseEditNodeArgs('n1', 'c', null, 'x'.repeat(2000))).toMatchObject({
      ok: false,
      error: { details: ['reason is too long'] },
    });
  });

  it('validates feedback args (strategy filename + signal)', () => {
    expect(parseFeedbackArgs('learning3', 1)).toMatchObject({
      ok: true,
      data: { strategyName: 'learning3', signal: 1 },
    });
    expect(parseFeedbackArgs('../bad', 1)).toMatchObject({ ok: false });
    expect(parseFeedbackArgs('learning3', 99)).toMatchObject({ ok: false });
  });

  it('rejects tag text with control characters and over-long tags', () => {
    expect(parseTagText('  AI  ')).toEqual({ ok: true, data: 'AI' });
    expect(parseTagText('a\nb')).toMatchObject({
      ok: false,
      error: { details: ['tag contains control characters'] },
    });
    expect(parseTagText('x'.repeat(300))).toMatchObject({
      ok: false,
      error: { details: ['tag is too long'] },
    });
    expect(parseTagText('')).toMatchObject({ ok: false });
  });

  it('validates list archived opts with sane bounds', () => {
    expect(parseListArchivedOpts(undefined)).toEqual({ ok: true, data: { limit: 30, offset: 0 } });
    expect(parseListArchivedOpts({ limit: 50, offset: 10 })).toEqual({
      ok: true,
      data: { limit: 50, offset: 10 },
    });
    expect(parseListArchivedOpts({ limit: 0 })).toMatchObject({ ok: false });
    expect(parseListArchivedOpts({ offset: -1 })).toMatchObject({ ok: false });
  });

  it('caps search query and limit', () => {
    expect(parseSearchQuery('foo bar')).toEqual({ ok: true, data: 'foo bar' });
    expect(parseSearchQuery('x'.repeat(600))).toMatchObject({ ok: false });
    expect(parseSearchLimit(undefined)).toEqual({ ok: true, data: 20 });
    expect(parseSearchLimit(500)).toMatchObject({ ok: false });
  });

  it('parses nodes list filter, rejecting bad sortBy length', () => {
    const ok = parseNodesListFilter({
      type: 'record',
      archived: false,
      search: 'foo',
      sortBy: 'created',
      sortDir: 'DESC',
      limit: 50,
      offset: 0,
      tags: ['ai', 'ml'],
    });
    expect(ok.ok).toBe(true);
    expect(parseNodesListFilter({ sortBy: 'x'.repeat(64) })).toMatchObject({ ok: false });
    expect(parseNodesListFilter({ archived: 'true' })).toMatchObject({ ok: false });
    expect(parseNodesListFilter({ limit: 99999 })).toMatchObject({ ok: false });
  });

  it('whitelists note source physical paths under approved roots', () => {
    const home = os.homedir();
    expect(parseNoteSourcePath('logseq', home)).toMatchObject({ ok: true });
    expect(parseNoteSourcePath('logseq', `${home}/Notes`)).toMatchObject({ ok: true });
    expect(parseNoteSourcePath('logseq', '/etc')).toMatchObject({
      ok: false,
      error: { details: ['path outside allowed roots'] },
    });
    expect(parseNoteSourcePath('obsidian', '/etc/passwd')).toMatchObject({ ok: false });
    // notion / apple-notes 跳过路径白名单（path 是 token / 含 query string）
    expect(parseNoteSourcePath('notion', 'notion://secret_xyz')).toMatchObject({ ok: true });
    expect(parseNoteSourcePath('apple-notes', '/var/path?accounts=1')).toMatchObject({ ok: true });
  });

  it('rejects note-source create with paths outside allowed roots', () => {
    const bad = parseNoteSourceCreate({
      name: 'evil',
      toolType: 'logseq',
      path: '/etc',
      pollInterval: 30,
    });
    expect(bad).toMatchObject({
      ok: false,
      error: { details: ['path outside allowed roots'] },
    });
  });

  it('rejects plugin agentName with control characters / quotes', () => {
    expect(parsePluginGenerateInput({
      agentId: 'eb_1234abcd',
      agentName: 'bad"name',
    })).toMatchObject({
      ok: false,
      error: { details: ['agentName contains invalid characters'] },
    });
    expect(parsePluginGenerateInput({
      agentId: 'eb_1234abcd',
      agentName: 'line\nbreak',
    })).toMatchObject({ ok: false });
  });
});
