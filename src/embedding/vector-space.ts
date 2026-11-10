import type { VectorRuntimeState } from '../db/vector-cache-store.js';
export interface VectorSpaceStamp { profileId: string; epoch: string; nodeId?: string; inputHash?: string }
const spaces = new WeakMap<Float32Array, Readonly<VectorSpaceStamp>>();
export function stampVector(vector: Float32Array, runtime: VectorRuntimeState, source?: {nodeId:string;inputHash:string}): Float32Array {
  spaces.set(vector,Object.freeze({profileId:runtime.selection.id,epoch:runtime.epoch,...source}));
  return vector;
}
export function vectorSpace(vector: Float32Array): Readonly<VectorSpaceStamp> | undefined { return spaces.get(vector); }
