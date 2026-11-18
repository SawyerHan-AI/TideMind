import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ClassifiedFile as ObsClassifiedFile, FileSyncState } from './types.js';
import { preprocessFile, stripCodeForScan } from './preprocessor.js';
import { extractAliasesQuick } from './frontmatter.js';
import { readVaultConfig } from './vault-config.js';
import { classifyFiles } from './classifier.js';
import { segmentContent } from './segmenter.js';
import { retireNodeWithoutReplacement } from '../../db/node-lifecycle.js';
import { getAllFileStates, computeContentHash } from './sync-state.js';
import { safeReadVaultTextFileSync } from '../../utils/safe-fs.js';
import { createLink, linkExists, deleteLink } from '../../db/links.js';
import { updateNode } from '../../db/nodes.js';
import { SqliteRepository } from '../../db/sqlite-repository.js';
import { digest } from '../../tools/digest.js';

interface NoteReferences {
  aliases: string[];
  refs: string[];
}

interface CachedReferences extends NoteReferences {
  hash: string;
  headingNames: string[];
}

// Cache only parsed reference metadata for a committed content hash. Never retain note bodies.
const referenceCaches = new WeakMap<Database.Database, Map<string, Map<string, CachedReferences>>>();

function readReferences(content: string, relPath: string): NoteReferences {
  if (relPath.endsWith('.canvas')) return { aliases: [], refs: [] };
  const text = stripCodeForScan(content);
  const refs = new Set([...text.matchAll(/(?<!!)\[\[([^\]]+)\]\]/g)].map(match => match[1]));
  for (const match of text.matchAll(/(?<!!)\[[^\]\n]+\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)) {
    const href = match[1] ?? match[2];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;
    try {
      const decoded = decodeURIComponent(href);
      const [file, ...fragment] = decoded.split('#');
      if (!file || (path.posix.extname(file) && !/\.md$/i.test(file))) continue;
      const relative = file.startsWith('/') ? file.slice(1) : path.posix.join(path.posix.dirname(relPath), file);
      if (relative.startsWith('../')) continue;
      refs.add('/' + relative + (fragment.length ? '#' + fragment.join('#') : ''));
    } catch { /* Invalid percent encoding is not a vault reference. */ }
  }
  return { aliases: extractAliasesQuick(content), refs: [...refs] };
}

function checkpointFingerprint(states: Map<string, FileSyncState>): string {
  const hash = createHash('sha256');
  for (const relPath of [...states.keys()].sort()) {
    const state = states.get(relPath)!;
    hash.update(JSON.stringify([relPath, state.content_hash, state.node_ids]));
  }
  return hash.digest('hex');
}

export function linksNeedRefresh(db: Database.Database, sourceId: string | undefined, states: Map<string, FileSyncState>): boolean {
  const key = `obsidian_explicit_links_v1_${sourceId ?? '__default__'}`;
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value !== checkpointFingerprint(states);
}

export async function refreshObsidianLinks(db: Database.Database, vaultRoot: string, sourceId?: string, shouldStop?: () => boolean, offlinePaths: readonly string[] = []): Promise<{ created: number; dangling: number }> {
  const checkStopped = () => { if (shouldStop?.()) throw new Error('Obsidian 引用同步已停止'); };
  checkStopped();
  clearDanglingTagCache();
  const marker = `obsidian_explicit_links_v1_${sourceId ?? '__default__'}`;
  // A failure after writing some edges must remain retryable even if the note hashes did not change.
  db.prepare('DELETE FROM metadata WHERE key = ?').run(marker);
  const config = readVaultConfig(vaultRoot);
  const states = getAllFileStates(db, sourceId);
  const files: ObsClassifiedFile[] = [];
  const references = new Map<string, NoteReferences>();
  const nodes = new Map<string, string[]>();
  const headings = new Map<string, string>();
  let hasUnavailableTargets = offlinePaths.length > 0;
  let vaults = referenceCaches.get(db);
  if (!vaults) { vaults = new Map(); referenceCaches.set(db, vaults); }
  const key = JSON.stringify([sourceId, vaultRoot, config]);
  const previous = vaults.get(key);
  const next = new Map<string, CachedReferences>();
  const isLive = db.prepare('SELECT 1 FROM nodes WHERE id = ? AND archived = 0 AND is_superseded = 0');
  // The scanner owns deletion arbitration. Its retained rows include offline notes,
  // so an unavailable target can still be addressed by path and its last known aliases.
  for (const [relPath, state] of states) {
    const absPath = path.join(vaultRoot, relPath);
    files.push({ relPath, absPath, category: 'regular', inDegree: 0 });
    const ids = state.node_ids.filter(id => isLive.get(id));
    nodes.set(relPath, ids);
    let page = previous?.get(relPath);
    if (!page || page.hash !== state.content_hash) {
      const read = safeReadVaultTextFileSync(absPath, vaultRoot);
      if (!read.ok || computeContentHash(read.content) !== state.content_hash) { hasUnavailableTargets = true; continue; }
      const [file] = classifyFiles([absPath], vaultRoot, config, () => read.content);
      const pre = file.category === 'canvas' ? null : preprocessFile(absPath, vaultRoot, undefined, read.content);
      const segments = pre ? segmentContent(pre.cleanContent, file.category, pre.title) : [];
      page = { hash: state.content_hash, headingNames: segments.map(segment => segment.context), ...readReferences(read.content, relPath) };
    }
    references.set(relPath, page);
    next.set(relPath, page);
    if (page.headingNames.length === ids.length) page.headingNames.forEach((name, i) => {
      if (name) headings.set(`${relPath}#${name}`, ids[i]);
    });
  }
  for (const absPath of offlinePaths) {
    const relPath = path.relative(vaultRoot, absPath).split(path.sep).join('/');
    if (!states.has(relPath)) files.push({ relPath, absPath, category: 'regular', inDegree: 0 });
  }
  const result = await reconcileExplicitLinks(db, files, nodes, references, headings, checkStopped, hasUnavailableTargets);
  vaults.set(key, next);
  if (!hasUnavailableTargets) {
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(marker, checkpointFingerprint(states));
  }
  return result;
}

async function reconcileExplicitLinks(
  db: Database.Database,
  files: ObsClassifiedFile[],
  fileToNodeIds: Map<string, string[]>,
  references: Map<string, NoteReferences>,
  headingToNodeId: Map<string, string>,
  checkStopped: () => void,
  preserveUnresolved: boolean,
): Promise<{ created: number; dangling: number }> {
  let created = 0;
  let dangling = 0;
  const desired = new Set<string>();
  const touched = new Set<string>();
  const uncertain = new Set<string>();
  const hasLink = (from: string, to: string): boolean => {
    desired.add(`${from}\0${to}`);
    return linkExists(db, from, to, 'from_to');
  };

  const normalize = (name: string) => name.normalize('NFC').toLowerCase();
  const paths = new Map(files.map(file => [normalize(file.relPath.replace(/\.md$/i, '')), file.relPath]));
  const names = new Map<string, Set<string>>();
  for (const file of files) {
    const keys = [path.basename(file.relPath, path.extname(file.relPath)),
      ...(references.get(file.relPath)?.aliases ?? [])];
    for (const key of keys) {
      const normalized = normalize(key);
      if (!names.has(normalized)) names.set(normalized, new Set());
      names.get(normalized)!.add(file.relPath);
    }
  }
  const resolve = (name: string, from: string): string | undefined => {
    const key = normalize(name.trim().replace(/\.md$/i, ''));
    if (key.startsWith('/')) return paths.get(key.slice(1));
    const exact = paths.get(key);
    if (exact) return exact;
    const relative = paths.get(normalize(path.posix.normalize(path.posix.join(path.posix.dirname(from), key))));
    if (relative) return relative;
    const candidates = names.get(key);
    return candidates?.size === 1 ? [...candidates][0] : undefined;
  };

  for (const file of files) {
    checkStopped();
    if (['template', 'attachment'].includes(file.category)) continue;

    const sourceNodeIds = fileToNodeIds.get(file.relPath);
    if (!sourceNodeIds || sourceNodeIds.length === 0) continue;

    const page = references.get(file.relPath);
    if (!page) continue;
    touched.add(sourceNodeIds[0]);

    for (const ref of page.refs) {
      checkStopped();
      // 解析 ref：[[page|alias]] → page, [[page#heading]] → page + heading
      let pageName = ref;
      let heading: string | null = null;

      // 处理 alias
      const pipeIdx = ref.indexOf('|');
      if (pipeIdx > 0) {
        pageName = ref.slice(0, pipeIdx);
      }

      // 处理 heading/block
      const hashIdx = pageName.indexOf('#');
      if (hashIdx === 0) {
        // [[#heading]] / [[#^block-id]] —— 以 # 开头表示本页引用，
        // 没有目标 page 可解析，直接跳过；否则会把 '#heading' 作为 tag 名
        // 去走悬空分支，造成脏 tag 节点
        continue;
      }
      if (hashIdx > 0) {
        const fragment = pageName.slice(hashIdx + 1);
        pageName = pageName.slice(0, hashIdx);
        if (fragment.startsWith('^')) {
          // [[note#^block-id]] 是 block-level 引用，headingToNodeId 存的是
          // heading 文本键，用 block id 查永远命中不了，只会把 block id 误
          // 当 heading。直接不当 heading 处理，退化为 page 级链接。
          heading = null;
        } else {
          heading = fragment;
        }
      }

      const targetPath = resolve(pageName, file.relPath);

      // 过滤附件类扩展名（即便没有 ! 前缀，[[image.png]] / [[file.pdf]] 也不应进入笔记图谱）
      if (/\.(png|jpe?g|gif|webp|svg|pdf|mp3|mp4|webm|mov|wav)$/i.test(pageName)) {
        continue;
      }

      // 尝试段级链接
      if (heading && preserveUnresolved && targetPath && !references.has(targetPath)) { uncertain.add(sourceNodeIds[0]); continue; }
      if (heading) {
        const headingKey = `${targetPath}#${heading}`;
        const targetNodeId = headingToNodeId.get(headingKey);
        if (targetNodeId) {
          const sourceId = sourceNodeIds[0];
          if (sourceId !== targetNodeId && !hasLink(sourceId, targetNodeId)) {
            createLink(db, {
              from_id: sourceId,
              to_id: targetNodeId,
              relation: [{ type: 'tagged', confidence: 0.5 }],
              strength: 0.9,
              note: `Obsidian 引用: [[${ref}]]`,
              auto: true,
              status: 'pending',
            });
            created++;
          }
          continue;
        }
      }

      // 页级链接
      const targetNodeIds = targetPath ? fileToNodeIds.get(targetPath) : undefined;
      if (targetNodeIds && targetNodeIds.length > 0) {
        const sourceId = sourceNodeIds[0];
        const targetId = targetNodeIds[0];
        if (sourceId !== targetId && !hasLink(sourceId, targetId)) {
          createLink(db, {
            from_id: sourceId,
            to_id: targetId,
            relation: [{ type: 'tagged', confidence: 0.5 }],
            strength: 0.9,
            note: `Obsidian 引用: [[${ref}]]`,
            auto: true,
            status: 'pending',
          });
          created++;
        }
      } else {
        // 已存在但本轮未入库/歧义的文件不能伪造悬空标签。
        if (targetPath || names.has(normalize(pageName))) { uncertain.add(sourceNodeIds[0]); dangling++; continue; }
        if (preserveUnresolved) { uncertain.add(sourceNodeIds[0]); dangling++; continue; }
        // 悬空引用 → 创建 tag 节点
        if (pageName.startsWith('/')) { dangling++; continue; }
        if (!pageName.trim()) continue;
        dangling++;
        const tagId = await createDanglingTagNode(db, pageName, checkStopped);
        const from = sourceNodeIds[0];
        if (from !== tagId && !hasLink(from, tagId)) {
          createLink(db, {
            from_id: from, to_id: tagId,
            relation: [{ type: 'tagged', confidence: 0.5 }],
            strength: 0.7, note: `Obsidian 悬空引用: [[${pageName}]]`,
            auto: true, status: 'pending',
          });
          created++;
        }
      }
    }
  }

  // 仅回收此来源自动创建的引用，保留手工/语义关系；先建期望集后比较，重复执行不增殖。
  for (const from of touched) {
    checkStopped();
    if (uncertain.has(from)) continue;
    const owned = db.prepare("SELECT id, to_id FROM links WHERE from_id = ? AND auto = 1 AND deleted = 0 AND status != 'rejected_by_user' AND (note LIKE 'Obsidian 引用:%' OR note LIKE 'Obsidian 悬空引用:%')").all(from) as { id: string; to_id: string }[];
    for (const link of owned) {
      if (!desired.has(`${from}\0${link.to_id}`)) deleteLink(db, link.id);
    }
  }
  return { created, dangling };
}

// 悬空引用 tag 节点缓存
// 注意：模块级 Map，必须在每次全量运行的入口清空，避免跨 vault / 跨轮次污染
const danglingTagCache = new Map<string, string>();

/** 清空悬空引用 tag 缓存（runInitialization / triggerFullRescan 入口调用） */
export function clearDanglingTagCache(): void {
  danglingTagCache.clear();
}

async function createDanglingTagNode(db: Database.Database, name: string, checkStopped: () => void): Promise<string> {
  const repo = new SqliteRepository(db);
  // cache key 与 DB 查询的大小写必须一致。原版用 lower-case 做 cache key 但 DB
  // 查询用原始 case(content/title 大小写敏感精确匹配)→ `[[Foo]]` 和 `[[foo]]`
  // 共享 cache 但分别命中 DB 两个不同节点,cache 第一次填啥后续就稳定指错一个。
  // 对齐 property-promote.ts:42-49 的同模式修复。
  const cacheKey = name.trim();
  if (danglingTagCache.has(cacheKey)) return danglingTagCache.get(cacheKey)!;

  const existing = db.prepare(
    "SELECT id FROM nodes WHERE is_tag = 1 AND (content = ? OR title = ?) AND archived = 0 AND is_superseded = 0 LIMIT 1",
  ).get(name, name) as { id: string } | undefined;

  if (existing) {
    danglingTagCache.set(cacheKey, existing.id);
    return existing.id;
  }

  checkStopped();
  const result = await digest(repo, {
    content: name,
    title: name,
    source: { tool: 'obsidian' },
    context: `Obsidian 悬空引用 tag: ${name}`,
    tags: [name],
    async: false,
    // 身份由精确匹配 + 缓存负责（上方已查过 existing）
    skipDedupMerge: true,
  });

  try { checkStopped(); } catch (err) {
    for (const node of result.created_nodes ?? []) retireNodeWithoutReplacement(db, node.id);
    throw err;
  }
  const nodeId = result.created_nodes?.[0]?.id;
  if (nodeId) {
    updateNode(db, nodeId, { is_tag: 1 });
    danglingTagCache.set(cacheKey, nodeId);
    return nodeId;
  }
  throw new Error('Obsidian reference did not produce a tag node');
}
