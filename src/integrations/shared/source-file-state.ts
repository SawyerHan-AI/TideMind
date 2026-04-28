import path from 'node:path';

export interface SourceFileScan {
  processableFiles: string[];
  datalessFiles: string[];
}

export interface SyncStateWithNodes {
  node_ids: string[];
}

export interface StaleSyncStatePlan {
  staleFilePaths: string[];
  orphanNodeIds: string[];
}

export function createSourceFileScan(
  processableFiles: string[],
  datalessFiles: string[],
): SourceFileScan {
  return { processableFiles, datalessFiles };
}

export function getAllKnownFiles(scan: SourceFileScan): string[] {
  return [...scan.processableFiles, ...scan.datalessFiles];
}

export function toSourceRelativePath(sourceRoot: string, filePath: string): string {
  return path.relative(sourceRoot, filePath).replace(/\\/g, '/');
}

export function buildKnownRelPathSet(sourceRoot: string, scan: SourceFileScan): Set<string> {
  return new Set(getAllKnownFiles(scan).map(filePath => toSourceRelativePath(sourceRoot, filePath)));
}

export function collectChangedProcessableFiles<TSyncState>(
  sourceRoot: string,
  processableFiles: string[],
  syncStates: Map<string, TSyncState>,
  isChanged: (filePath: string, syncState: TSyncState | null) => boolean,
): string[] {
  const filesToProcess: string[] = [];

  for (const filePath of processableFiles) {
    const relPath = toSourceRelativePath(sourceRoot, filePath);
    const syncState = syncStates.get(relPath) ?? null;

    if (isChanged(filePath, syncState)) {
      filesToProcess.push(filePath);
    }
  }

  return filesToProcess;
}

export function planStaleSyncStateCleanup<TSyncState extends SyncStateWithNodes>(
  syncStates: Map<string, TSyncState>,
  currentRelPaths: Set<string>,
): StaleSyncStatePlan {
  const staleFilePaths: string[] = [];
  const orphanNodeIds: string[] = [];

  for (const [filePath, state] of syncStates.entries()) {
    if (currentRelPaths.has(filePath)) continue;

    staleFilePaths.push(filePath);
    if (state.node_ids.length > 0) {
      orphanNodeIds.push(...state.node_ids);
    }
  }

  return { staleFilePaths, orphanNodeIds };
}
