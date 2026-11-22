import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DERIVED_NODE_SOURCE_TOOLS, isDerivedNode, normalizeExternalSourceTool,
} from '../../src/metabolism/derived-sources.js';

describe('derived node identification', () => {
  it('requires both an organizer source and a derived marker', () => {
    expect(isDerivedNode({ source_tool: 'temporal-crystal', is_crystal: 1 })).toBe(true);
    expect(isDerivedNode({ source_tool: 'tag-promote', is_tag: true })).toBe(true);
    expect(isDerivedNode({ source_tool: 'profile-synthesize', is_meta: 1 })).toBe(true);
    // user correction record / imported tag node / plain memory
    expect(isDerivedNode({ source_tool: 'claude-code', is_meta: 1 })).toBe(false);
    expect(isDerivedNode({ source_tool: 'obsidian', is_tag: 1 })).toBe(false);
    expect(isDerivedNode({ source_tool: null, is_tag: 1 })).toBe(false);
    // an agent that happens to use an organizer name for an ordinary memory
    expect(isDerivedNode({ source_tool: 'tag-promote', is_crystal: 0, is_tag: 0, is_meta: 0 })).toBe(false);
  });

  it('rewrites caller-supplied sources that collide with organizer names', () => {
    expect(normalizeExternalSourceTool('tag-promote')).toBe('external:tag-promote');
    expect(normalizeExternalSourceTool('claude-code')).toBe('claude-code');
    expect(normalizeExternalSourceTool(undefined)).toBeUndefined();
  });

  // Every organizer task that creates a node must label it with a registered
  // source_tool, otherwise a non-primary device could upload its results.
  it('every createNode in organizer tasks carries a registered source_tool', () => {
    const offenders: string[] = [];
    for (const dir of ['src/metabolism', 'src/evolution']) {
      for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
        const source = readFileSync(join(dir, file), 'utf8');
        for (const match of source.matchAll(/createNode\(\s*db\s*,\s*\{([\s\S]*?)\n\s*\}\s*\)/g)) {
          const tool = /source_tool:\s*'([^']+)'/.exec(match[1])?.[1];
          if (!tool || !DERIVED_NODE_SOURCE_TOOLS.includes(tool)) offenders.push(`${dir}/${file}: ${tool ?? 'no source_tool'}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
