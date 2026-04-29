import { describe, expect, it } from 'vitest';
import { isConfirmedNotionPageGoneError } from '../../../src/integrations/notion/api-client.js';

describe('Notion API error classification', () => {
  it('treats explicit page gone errors as confirmed deletion or unshare', () => {
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('missing'), { status: 404 }))).toBe(true);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('restricted'), { status: 403 }))).toBe(true);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('object_not_found'), { code: 'object_not_found' }))).toBe(true);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('restricted_resource'), { code: 'restricted_resource' }))).toBe(true);
  });

  it('does not treat transient or credential-wide errors as page deletion', () => {
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(false);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('bad gateway'), { status: 502 }))).toBe(false);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('service unavailable'), { status: 503 }))).toBe(false);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('unauthorized'), { status: 401 }))).toBe(false);
  });
});
