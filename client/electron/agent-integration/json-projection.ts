import fs from 'node:fs'
import { sha256Json } from './fingerprint'
import {
  ensureSafeParentDirectoryWithinRoot,
  inspectRegularFile,
  inspectRegularFileWithinRoot,
  writeRegularFileAtomicCas,
  type FileFingerprint,
} from './safe-file'
import type { JsonValue } from './types'

export type JsonSelector = readonly string[]
export type JsonProjectionAction = 'create' | 'update' | 'remove' | 'noop' | 'conflict'

export interface JsonProjectionInspection {
  file: FileFingerprint
  selector: JsonSelector
  fragmentExists: boolean
  fragment: JsonValue | undefined
  fragmentHash: string | null
}

export interface JsonProjectionPlan {
  targetPath: string
  canonicalPath: string
  selector: JsonSelector
  action: JsonProjectionAction
  containerPreconditionHash: string | null
  liveFragmentHash: string | null
  ownedFragmentHash: string | null
  desiredFragment: JsonValue | undefined
  desiredFragmentHash: string | null
  conflictReason: string | null
}

export class JsonProjectionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonProjectionConflictError'
  }
}

export function inspectJsonProjection(
  targetPath: string,
  selector: JsonSelector,
  allowedRoot?: string,
): JsonProjectionInspection {
  assertSelector(selector)
  const file = allowedRoot
    ? inspectRegularFileWithinRoot(targetPath, allowedRoot)
    : inspectRegularFile(targetPath)
  if (!file.exists) {
    return { file, selector: [...selector], fragmentExists: false, fragment: undefined, fragmentHash: null }
  }

  let document: unknown
  try {
    document = JSON.parse(fs.readFileSync(file.canonicalPath, 'utf8'))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new JsonProjectionConflictError(`Managed JSON container is malformed: ${file.canonicalPath} (${reason})`)
  }
  if (!isJsonObject(document)) {
    throw new JsonProjectionConflictError(`Managed JSON container root must be an object: ${file.canonicalPath}`)
  }

  const found = getJsonFragment(document, selector)
  return {
    file,
    selector: [...selector],
    fragmentExists: found.exists,
    fragment: found.value,
    fragmentHash: found.exists ? sha256Json(found.value) : null,
  }
}

export function planJsonProjection(input: {
  targetPath: string
  selector: JsonSelector
  desiredFragment: JsonValue | undefined
  ownedFragmentHash: string | null
  allowedRoot?: string
}): JsonProjectionPlan {
  const inspection = inspectJsonProjection(input.targetPath, input.selector, input.allowedRoot)
  const desiredHash = input.desiredFragment === undefined ? null : sha256Json(input.desiredFragment)

  if (inspection.fragmentHash === desiredHash) {
    if (inspection.fragmentExists && input.ownedFragmentHash === null) {
      return makePlan(input, inspection, desiredHash, 'conflict', 'matching_selector_has_no_ownership_evidence')
    }
    return makePlan(input, inspection, desiredHash, 'noop', null)
  }

  if (input.desiredFragment === undefined) {
    if (!inspection.fragmentExists) return makePlan(input, inspection, desiredHash, 'noop', null)
    if (input.ownedFragmentHash === null || inspection.fragmentHash !== input.ownedFragmentHash) {
      return makePlan(input, inspection, desiredHash, 'conflict', 'remove_requires_exact_owned_fragment')
    }
    return makePlan(input, inspection, desiredHash, 'remove', null)
  }

  if (!inspection.fragmentExists) {
    if (input.ownedFragmentHash !== null) {
      return makePlan(input, inspection, desiredHash, 'create', null)
    }
    return makePlan(input, inspection, desiredHash, 'create', null)
  }

  // A selector that already exists but was never verified as Tide Mind-owned
  // is not adoptable based on its name or desired-content coincidence alone.
  if (input.ownedFragmentHash === null) {
    return makePlan(input, inspection, desiredHash, 'conflict', 'selector_already_occupied')
  }
  if (inspection.fragmentHash !== input.ownedFragmentHash) {
    return makePlan(input, inspection, desiredHash, 'conflict', 'owned_fragment_modified')
  }
  return makePlan(input, inspection, desiredHash, 'update', null)
}

export function applyJsonProjection(plan: JsonProjectionPlan, allowedRoot?: string): JsonProjectionInspection {
  if (plan.action === 'conflict') {
    throw new JsonProjectionConflictError(plan.conflictReason ?? 'projection_conflict')
  }
  if (plan.action === 'noop') return inspectJsonProjection(plan.targetPath, plan.selector, allowedRoot)

  const current = inspectJsonProjection(plan.targetPath, plan.selector, allowedRoot)
  if (current.file.canonicalPath !== plan.canonicalPath) {
    throw new JsonProjectionConflictError('container_canonical_path_changed')
  }
  if (current.file.containerHash !== plan.containerPreconditionHash) {
    throw new JsonProjectionConflictError('container_precondition_changed')
  }
  if (current.fragmentHash !== plan.liveFragmentHash) {
    throw new JsonProjectionConflictError('fragment_precondition_changed')
  }

  const document = current.file.exists
    ? parseObject(current.file.canonicalPath)
    : {}
  if (plan.action === 'remove') {
    deleteJsonFragment(document, plan.selector)
  } else {
    if (plan.desiredFragment === undefined) throw new Error('Missing desired JSON fragment')
    setJsonFragment(document, plan.selector, plan.desiredFragment)
  }

  if (allowedRoot) ensureSafeParentDirectoryWithinRoot(plan.targetPath, allowedRoot)
  writeRegularFileAtomicCas(plan.targetPath, `${JSON.stringify(document, null, 2)}\n`, {
    expectedContainerHash: plan.containerPreconditionHash,
    expectedCanonicalPath: plan.canonicalPath,
  })
  const after = inspectJsonProjection(plan.targetPath, plan.selector, allowedRoot)
  if (after.fragmentHash !== plan.desiredFragmentHash) {
    throw new JsonProjectionConflictError('fragment_read_back_mismatch')
  }
  return after
}

function makePlan(
  input: {
    targetPath: string
    selector: JsonSelector
    desiredFragment: JsonValue | undefined
    ownedFragmentHash: string | null
  },
  inspection: JsonProjectionInspection,
  desiredFragmentHash: string | null,
  action: JsonProjectionAction,
  conflictReason: string | null,
): JsonProjectionPlan {
  return {
    targetPath: input.targetPath,
    canonicalPath: inspection.file.canonicalPath,
    selector: [...input.selector],
    action,
    containerPreconditionHash: inspection.file.containerHash,
    liveFragmentHash: inspection.fragmentHash,
    ownedFragmentHash: input.ownedFragmentHash,
    desiredFragment: input.desiredFragment,
    desiredFragmentHash,
    conflictReason,
  }
}

function parseObject(filePath: string): Record<string, JsonValue> {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!isJsonObject(parsed)) throw new JsonProjectionConflictError('container_root_not_object')
  return parsed
}

function getJsonFragment(root: Record<string, JsonValue>, selector: JsonSelector): {
  exists: boolean
  value: JsonValue | undefined
} {
  let current: JsonValue = root
  for (const key of selector) {
    if (!isJsonObject(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
      return { exists: false, value: undefined }
    }
    current = current[key]
  }
  return { exists: true, value: current }
}

function setJsonFragment(root: Record<string, JsonValue>, selector: JsonSelector, value: JsonValue): void {
  let current = root
  for (const key of selector.slice(0, -1)) {
    const child = current[key]
    if (child === undefined) {
      const created: Record<string, JsonValue> = {}
      current[key] = created
      current = created
      continue
    }
    if (!isJsonObject(child)) throw new JsonProjectionConflictError(`selector_parent_not_object:${key}`)
    current = child
  }
  current[selector[selector.length - 1]] = value
}

function deleteJsonFragment(root: Record<string, JsonValue>, selector: JsonSelector): void {
  const parents: Array<{ parent: Record<string, JsonValue>; key: string }> = []
  let current = root
  for (const key of selector.slice(0, -1)) {
    const child = current[key]
    if (!isJsonObject(child)) return
    parents.push({ parent: current, key })
    current = child
  }
  delete current[selector[selector.length - 1]]

  // Remove only empty containers traversed by this selector. Never touch
  // siblings or user-owned parent content.
  for (const { parent, key } of parents.reverse()) {
    const child = parent[key]
    if (isJsonObject(child) && Object.keys(child).length === 0) delete parent[key]
    else break
  }
}

function assertSelector(selector: JsonSelector): void {
  if (selector.length === 0 || selector.some(key => key.length === 0 || key === '__proto__' || key === 'constructor' || key === 'prototype')) {
    throw new JsonProjectionConflictError('invalid_json_selector')
  }
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
