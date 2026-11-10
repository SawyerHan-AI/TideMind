import { createHash } from 'node:crypto';
import {
  EMBEDDING_INPUT_VERSION, EMBEDDING_SEGMENT_VERSION,
  nodeEmbeddingInput, nodeEmbeddingInputHash, segmentForEmbedding,
} from './input-contract.js';

export const VECTOR_CACHE_LIMITS = Object.freeze({
  accountBytes: 1024 ** 3, accountBundles: 50_000, accountProfiles: 2,
  segments: 128, dimensions: 4096, vectorBytes: 2 * 1024 ** 2,
  metadataBytes: 256 * 1024, transportBytes: 4 * 1024 ** 2, lookupKeys: 200,
});

type OptionValue = string | number | boolean | null;
export interface EmbeddingProfile {
  version: 1;
  provider: string;
  model: string;
  revision: string | null;
  /** SHA-256 of a credential-free service identity; never a URL or account ID. */
  serviceIdentity: string;
  dimensions: number;
  requestOptions: Record<string, OptionValue>;
  normalization: 'l2-f32-v1';
  inputVersion: typeof EMBEDDING_INPUT_VERSION;
  segmentVersion: typeof EMBEDDING_SEGMENT_VERSION;
}
export interface VectorBundle {
  version: 1;
  nodeId: string;
  inputHash: string;
  profile: EmbeddingProfile;
  profileId: string;
  segments: Array<{ index: number; textHash: string; vector: string }>;
  checksum: string;
}
const HASH = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function invalid(reason: string): never { throw new Error(`invalid vector bundle: ${reason}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('object required');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid('non-plain object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid('unexpected fields');
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}
/** Deterministic JSON for the narrow JSON-only contract. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function validateEmbeddingProfile(value: unknown): EmbeddingProfile {
  const p = record(value);
  keys(p, ['version','provider','model','revision','serviceIdentity','dimensions','requestOptions','normalization','inputVersion','segmentVersion']);
  if (p.version !== 1 || !boundedText(p.provider, 64) || !boundedText(p.model, 256)
    || (p.revision !== null && !boundedText(p.revision, 256))
    || typeof p.serviceIdentity !== 'string' || !HASH.test(p.serviceIdentity)
    || !Number.isInteger(p.dimensions) || Number(p.dimensions) < 1 || Number(p.dimensions) > VECTOR_CACHE_LIMITS.dimensions
    || p.normalization !== 'l2-f32-v1' || p.inputVersion !== EMBEDDING_INPUT_VERSION
    || p.segmentVersion !== EMBEDDING_SEGMENT_VERSION) invalid('unsupported profile');
  const options = record(p.requestOptions);
  // Only reviewed request semantics belong in a portable profile. Never spread
  // connection/config objects here: arbitrary fields may contain credentials/URLs.
  for (const [key, option] of Object.entries(options)) {
    const valid = (key === 'outputDimensionality' && Number.isInteger(option)
        && Number(option) === p.dimensions)
      || (key === 'truncate' && typeof option === 'boolean')
      || (key === 'taskType' && typeof option === 'string' && ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY', 'SEMANTIC_SIMILARITY', 'CLASSIFICATION', 'CLUSTERING'].includes(option));
    if (!valid) invalid('unreviewed request option');
  }
  return value as EmbeddingProfile;
}
export function embeddingProfileId(profile: EmbeddingProfile): string {
  return hash(canonical(validateEmbeddingProfile(profile)));
}
export function encodeVector(vector: Float32Array): string {
  if (!vector.length || vector.length > VECTOR_CACHE_LIMITS.dimensions) invalid('vector dimensions');
  const bytes = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) invalid('non-finite vector');
    bytes.writeFloatLE(vector[i], i * 4);
  }
  return bytes.toString('base64');
}
export function decodeVector(encoded: string, dimensions: number): Float32Array {
  const byteLength = dimensions * 4;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > VECTOR_CACHE_LIMITS.dimensions
    || typeof encoded !== 'string' || encoded.length !== 4 * Math.ceil(byteLength / 3)
    || !BASE64.test(encoded)) invalid('vector encoding');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== byteLength || bytes.toString('base64') !== encoded) invalid('non-canonical vector encoding');
  const result = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    result[i] = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(result[i])) invalid('non-finite vector');
  }
  return result;
}
function bundleChecksum(bundle: Omit<VectorBundle, 'checksum'>): string { return hash(canonical(bundle)); }

/** Validate against current node input, not merely self-consistent client metadata. */
export function validateVectorBundle(value: unknown, node: { id: string; content: string; title?: string | null }): VectorBundle {
  const b = record(value);
  keys(b, ['version','nodeId','inputHash','profile','profileId','segments','checksum']);
  if (b.version !== 1 || !boundedText(b.nodeId, 256) || b.nodeId !== node.id
    || b.inputHash !== nodeEmbeddingInputHash(node.content, node.title)) invalid('node input');
  const profile = validateEmbeddingProfile(b.profile);
  if (b.profileId !== embeddingProfileId(profile)) invalid('profile checksum');
  const expected = segmentForEmbedding(nodeEmbeddingInput(node.content, node.title));
  if (!Array.isArray(b.segments) || !expected.length || expected.length > VECTOR_CACHE_LIMITS.segments
    || b.segments.length !== expected.length) invalid('segment completeness');
  if (b.segments.length * profile.dimensions * 4 > VECTOR_CACHE_LIMITS.vectorBytes) invalid('vector byte limit');
  for (let i = 0; i < expected.length; i++) {
    const segment = record(b.segments[i]);
    keys(segment, ['index','textHash','vector']);
    if (segment.index !== i || segment.textHash !== hash(expected[i])) invalid('segment input');
    const vector = decodeVector(segment.vector as string, profile.dimensions);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    // Match provider normalization tolerance; validate without changing bytes.
    if (Math.abs(norm - 1) > 1e-4) invalid('vector normalization');
  }
  const { checksum, ...payload } = b;
  if (typeof checksum !== 'string' || !HASH.test(checksum)
    || checksum !== bundleChecksum(payload as Omit<VectorBundle, 'checksum'>)) invalid('bundle checksum');
  const metadata = { ...b, segments: b.segments.map(({ index, textHash }) => ({ index, textHash })) };
  if (Buffer.byteLength(canonical(metadata)) > VECTOR_CACHE_LIMITS.metadataBytes
    || Buffer.byteLength(canonical(b)) > VECTOR_CACHE_LIMITS.transportBytes) invalid('metadata/transport limit');
  return value as VectorBundle;
}
export function createVectorBundle(node: { id: string; content: string; title?: string | null }, profile: EmbeddingProfile, vectors: Float32Array[]): VectorBundle {
  const segments = segmentForEmbedding(nodeEmbeddingInput(node.content, node.title));
  if (segments.length !== vectors.length) invalid('segment completeness');
  const payload: Omit<VectorBundle, 'checksum'> = {
    version: 1, nodeId: node.id, inputHash: nodeEmbeddingInputHash(node.content, node.title),
    profile: structuredClone(validateEmbeddingProfile(profile)), profileId: embeddingProfileId(profile),
    segments: segments.map((text, index) => ({ index, textHash: hash(text), vector: encodeVector(vectors[index]) })),
  };
  return validateVectorBundle({ ...payload, checksum: bundleChecksum(payload) }, node);
}
