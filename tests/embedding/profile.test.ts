import { describe, expect, it } from 'vitest';
import { selectEmbeddingProfile } from '../../src/embedding/profile.js';
import type { AppConfig } from '../../src/types.js';
const config=(provider='gemini',key='synthetic-key')=>({embedding:{provider,model:'ignored-ui-alias',dimensions:3072,connection:'local-only-connection'},gemini:{api_key:key},vertex:{region:'us-central1',project_id:'synthetic-project'},ollama:{url:'http://localhost:11434'}} as unknown as AppConfig);
describe('actual embedding request identity',()=>{
 it('uses the actual fixed Gemini model and does not include credentials or connection IDs',()=>{
  const a=selectEmbeddingProfile(config(),'device-a');
  const b=selectEmbeddingProfile(config('gemini','another-synthetic-key'),'device-b');
  expect(a.id).toBe(b.id);expect(a.shareable).toBe(true);
  expect(a.profile.model).toBe('gemini-embedding-001');
  expect(JSON.stringify(a)).not.toContain('synthetic-key');
  expect(JSON.stringify(a)).not.toContain('local-only-connection');
 });
 it('does not assume same-tag local model services on different devices are compatible',()=>{
  const a=selectEmbeddingProfile(config('ollama'),'device-a');
  const b=selectEmbeddingProfile(config('ollama'),'device-b');
  expect(a.shareable).toBe(false);expect(a.id).not.toBe(b.id);
  expect(JSON.stringify(a)).not.toContain('localhost');
 });
 it('separates provider spaces and dimensions',()=>{
  const a=selectEmbeddingProfile(config(),'device');
  const b=selectEmbeddingProfile(config('vertex'),'device');
  const small=config();small.embedding.dimensions=1536;
  expect(a.id).not.toBe(b.id);expect(a.id).not.toBe(selectEmbeddingProfile(small,'device').id);
 });
});
