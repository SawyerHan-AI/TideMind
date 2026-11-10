import { describe, expect, it } from 'vitest';
import { createVectorBundle, decodeVector, embeddingProfileId, encodeVector, validateVectorBundle, type EmbeddingProfile } from '../../src/embedding/bundle-contract.js';
import { EMBEDDING_INPUT_VERSION, EMBEDDING_SEGMENT_VERSION, segmentForEmbedding, nodeEmbeddingInput } from '../../src/embedding/input-contract.js';

const profile: EmbeddingProfile = {
  version: 1, provider: 'fixture', model: 'embedding-v1', revision: null,
  serviceIdentity: 'a'.repeat(64), dimensions: 3, requestOptions: {},
  normalization: 'l2-f32-v1', inputVersion: EMBEDDING_INPUT_VERSION, segmentVersion: EMBEDDING_SEGMENT_VERSION,
};
const node = { id: 'fixture-node', title: 'Fixture', content: 'A synthetic sentence. '.repeat(100) };
const make = () => createVectorBundle(node, profile,
  segmentForEmbedding(nodeEmbeddingInput(node.content, node.title)).map(() => new Float32Array([0, 0.6, 0.8])));

describe('shared lossless vector bundle contract', () => {
  it('round-trips exact float32 bytes, including signed zero and tiny values', () => {
    const vector = new Float32Array([0, -0, 1e-38, 0.1, -1e20]);
    const decoded = decodeVector(encodeVector(vector), vector.length);
    expect(Buffer.from(decoded.buffer)).toEqual(Buffer.from(vector.buffer));
  });
  it('accepts a complete bundle against current input and keeps profile detached from caller mutation', () => {
    const bundle = make();
    expect(validateVectorBundle(JSON.parse(JSON.stringify(bundle)), node)).toEqual(bundle);
    expect(bundle.profile).not.toBe(profile);
  });
  it('does not treat service identity or model changes as the same vector space', () => {
    expect(embeddingProfileId({ ...profile, serviceIdentity: 'b'.repeat(64) })).not.toBe(embeddingProfileId(profile));
    expect(embeddingProfileId({ ...profile, model: 'embedding-v2' })).not.toBe(embeddingProfileId(profile));
    expect(embeddingProfileId({ ...profile, requestOptions: { outputDimensionality: 3, truncate: true } }))
      .toBe(embeddingProfileId({ ...profile, requestOptions: { truncate: true, outputDimensionality: 3 } }));
  });
  it.each(['api_key', 'access_token', 'authorization', 'base_url', 'url', 'connection_id', 'unknown'])('rejects unreviewed option %s before encoding a portable profile', key => {
    expect(() => embeddingProfileId({ ...profile, requestOptions: { [key]: 'synthetic-private-value' } }))
      .toThrow('unreviewed request option');
  });
  it('rejects missing segments even when the node input hash remains correct', () => {
    const bundle = make();
    bundle.segments.pop();
    expect(() => validateVectorBundle(bundle, node)).toThrow('segment completeness');
  });
  it('rejects wrong segment text, reordering, changed content and unsupported algorithms', () => {
    const wrongText = make(); wrongText.segments[0].textHash = 'b'.repeat(64);
    expect(() => validateVectorBundle(wrongText, node)).toThrow('segment input');
    const reordered = make(); reordered.segments.reverse();
    expect(() => validateVectorBundle(reordered, node)).toThrow('segment input');
    expect(() => validateVectorBundle(make(), { ...node, content: 'new content' })).toThrow('node input');
    const future = make(); (future.profile as { segmentVersion: string }).segmentVersion = 'future';
    expect(() => validateVectorBundle(future, node)).toThrow('unsupported profile');
  });
  it.each([[0, 0, 0], [10, 0, 0]])('rejects a non-unit vector %j without silently renormalizing', (...values) => {
    expect(() => createVectorBundle({ id: 'short', content: 'text' }, profile, [new Float32Array(values)]))
      .toThrow('vector normalization');
  });
  it('rejects non-finite vectors, malformed encodings, wrong dimensions and tampering', () => {
    expect(() => encodeVector(new Float32Array([NaN]))).toThrow('non-finite');
    const infinity = Buffer.alloc(4); infinity.writeFloatLE(Infinity);
    expect(() => decodeVector(infinity.toString('base64'), 1)).toThrow('non-finite');
    expect(() => decodeVector('AAAA', 3)).toThrow('encoding');
    const bundle = make(); bundle.segments[0].vector = encodeVector(new Float32Array([1, 0, 0]));
    expect(() => validateVectorBundle(bundle, node)).toThrow('bundle checksum');
    expect(() => createVectorBundle({ id: 'short', content: 'text' }, profile, [new Float32Array([1])])).toThrow('encoding');
  });
});
