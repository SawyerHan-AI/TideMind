import { describe, expect, it, vi } from 'vitest';
import type { PageMetadata } from '../../../src/integrations/obsidian/types.js';
import {
  extractAliasesQuick,
  extractFrontmatter,
  extractFrontmatterWikilinks,
  filterSystemProperties,
} from '../../../src/integrations/obsidian/frontmatter.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

function metadata(): PageMetadata {
  return {
    aliases: [],
    tags: [],
    pageRefs: [],
    blockRefAssociations: [],
    properties: {},
    isJournal: false,
    filePath: 'note.md',
  };
}

describe('obsidian frontmatter helpers', () => {
  it('parses block scalars without treating embedded separators as terminators', () => {
    const meta = metadata();
    const result = extractFrontmatter(`---
title: Test
description: |
  line one
  ---
  line two
---
Body content stays here.`, meta);

    expect(result.changed).toBe(true);
    expect(result.body).toBe('Body content stays here.');
    expect(meta.properties.title).toBe('Test');
    expect(meta.properties.description).toContain('line two');
  });

  it('extracts frontmatter wikilinks and filters system properties', () => {
    const meta = metadata();
    meta.properties.source = '[[Book|Alias]]';
    meta.properties.cssclasses = 'dashboard';
    meta.aliases = ['[[Nickname]]'];

    extractFrontmatterWikilinks(meta);
    filterSystemProperties(meta);

    expect(meta.pageRefs).toEqual(['Book', 'Nickname']);
    expect(meta.properties.source).toBe('Book|Alias');
    expect(meta.properties.cssclasses).toBeUndefined();
    expect(meta.aliases).toEqual(['Nickname']);
  });

  it('extracts aliases quickly from CRLF frontmatter', () => {
    const aliases = extractAliasesQuick('---\r\nalias: Alpha, Beta\r\n---\r\nBody');

    expect(aliases).toEqual(['Alpha', 'Beta']);
  });
});
