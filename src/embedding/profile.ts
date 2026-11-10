import { createHash } from 'node:crypto';
import type { AppConfig } from '../types.js';
import { EMBEDDING_INPUT_VERSION, EMBEDDING_SEGMENT_VERSION } from './input-contract.js';
import { embeddingProfileId, type EmbeddingProfile } from './bundle-contract.js';

export interface EmbeddingProfileSelection {
  profile: EmbeddingProfile;
  id: string;
  shareable: boolean;
}
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Pure: credentials and local connection IDs must never enter the portable profile. */
export function selectEmbeddingProfile(config: AppConfig, localInstanceId: string): EmbeddingProfileSelection {
  const provider = config.embedding.provider;
  let source: string;
  let model: string;
  let shareable = true;
  if (provider === 'gemini') {
    source = 'google-generative-language:v1beta:embedContent';
    // The current request implementation uses this literal, not the UI model alias.
    model = 'gemini-embedding-001';
  } else if (provider === 'vertex') {
    const region = config.vertex.region === 'global' ? 'us-central1' : config.vertex.region;
    source = `google-vertex-ai:publisher-google:predict:${region}`;
    model = 'gemini-embedding-001';
  } else {
    if (!localInstanceId) throw new Error('A local embedding instance identity is required');
    const endpoint = new URL(config.ollama.url);
    endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = '';
    source = `ollama:unverified-local-instance:${localInstanceId}:${endpoint.toString().replace(/\/+$/, '')}`;
    model = config.embedding.model;
    shareable = false;
  }
  const profile: EmbeddingProfile = {
    version: 1, provider, model, revision: null,
    serviceIdentity: sha256(source), dimensions: config.embedding.dimensions,
    requestOptions: {}, normalization: 'l2-f32-v1',
    inputVersion: EMBEDDING_INPUT_VERSION, segmentVersion: EMBEDDING_SEGMENT_VERSION,
  };
  return { profile, id: embeddingProfileId(profile), shareable };
}
