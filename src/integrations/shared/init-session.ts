// ============================================================
// 笔记源初始化会话管理（统一真相源）
//
// 取代 logseq/obsidian/apple-notes/notion 各自维护的
// progressMap + abortedSet + initializingSet 三段式状态。
//
// 设计文档：docs/design/note-source-init-session.md
// ============================================================

import { createLogger } from '../../utils/logger.js';
import { now } from '../../utils/time.js';

const log = createLogger('init-session');

// ── 类型 ─────────────────────────────────────────────────────────

export type SessionStatus =
  | 'idle'        // 从未启动或已被 discard 清空
  | 'running'     // 正在跑某个 Phase
  | 'aborting'    // 收到 abort 信号，等待业务层确认停止
  | 'aborted'     // 业务层已确认停止
  | 'error'       // 非中断的失败
  | 'done';       // Phase 0–8 全部完成

export type AbortReason = 'user' | 'stuck' | 'navigation' | 'shutdown';

export type ToolType = 'logseq' | 'obsidian' | 'apple-notes' | 'notion';

export interface InitProgress {
  phase: number;
  phaseName: string;
  current: number;
  total: number;
  startedAt: string | null;
}

/**
 * 业务 runner 通过 ctx 上报状态、检查 signal、发心跳。
 * 不直接访问 SessionManager。
 */
export interface InitSessionContext {
  sourceId: string;
  signal: AbortSignal;
  reportPhase(phase: number, name: string, total: number): void;
  advance(delta?: number): void;
  setProgress(patch: Partial<InitProgress>): void;
  heartbeat(): void;
}

/**
 * 暴露到 IPC / 客户端的快照。**不**包含 controller / promise 等内部句柄。
 */
export interface InitSessionSnapshot {
  sourceId: string;
  toolType: ToolType;
  status: SessionStatus;
  progress: InitProgress;
  error: string | null;
  abortReason: AbortReason | null;
  /** 终态报告。结构由业务层定义，SessionManager 不感知字段细节。 */
  report: Record<string, unknown> | null;

  // 派生（主进程内集中计算，避免多端拼）
  canStart: boolean;
  canAbort: boolean;
  canDiscard: boolean;
}

interface InitSessionInternal {
  sourceId: string;
  toolType: ToolType;
  status: SessionStatus;
  progress: InitProgress;
  error: string | null;
  abortReason: AbortReason | null;
  report: Record<string, unknown> | null;

  controller: AbortController | null;
  promise: Promise<void> | null;

  startedAt: number;
  endedAt: number | null;
  lastTransitionAt: number;
}

export interface StartArgs {
  sourceId: string;
  toolType: ToolType;
  runner: (ctx: InitSessionContext) => Promise<Record<string, unknown>>;
}

export type StartResult =
  | { ok: true; snapshot: InitSessionSnapshot }
  | { ok: false; reason: 'another_running'; activeSourceId: string };

type TransitionListener = (snapshot: InitSessionSnapshot) => void;

// ── 默认值 ───────────────────────────────────────────────────────

const DEFAULT_PROGRESS: InitProgress = {
  phase: -1,
  phaseName: 'idle',
  current: 0,
  total: 0,
  startedAt: null,
};

/** abort 之后等业务 promise settle 的兜底超时（D5：10 秒）。 */
const ABORT_SETTLE_TIMEOUT_MS = 10_000;

/**
 * 各 Phase 的 stuck 阈值（毫秒）。
 * 超过该阈值未收到 heartbeat / progress 上报 → 自动 abort('stuck')。
 *
 * 设计文档第 5.4 节定义。Phase -1 表示尚未进入 Phase 0（启动阶段）。
 */
const STUCK_THRESHOLD_MS_BY_PHASE: Record<number, number> = {
  [-1]: 30_000,   // 启动阶段
  0: 30_000,      // 扫描
  1: 30_000,      // 预处理
  2: 60_000,      // 入库（IO + 偶尔慢的 digest）
  3: 30_000,      // 显式链接
  4: 180_000,     // 批量标注（LLM）
  5: 120_000,     // Landing
  6: 180_000,     // 链接评估（LLM）
  7: 60_000,      // Keystone
  8: 600_000,     // 涌现（最长，单次 LLM 可能数分钟）
};

const STUCK_CHECK_INTERVAL_MS = 5_000;

// ── 自定义错误 ───────────────────────────────────────────────────

export class InitAbortError extends Error {
  readonly reason: AbortReason;
  constructor(reason: AbortReason) {
    super(`init aborted: ${reason}`);
    this.name = 'InitAbortError';
    this.reason = reason;
  }
}

// ── Manager ──────────────────────────────────────────────────────

export class InitSessionManager {
  private sessions = new Map<string, InitSessionInternal>();
  private listeners = new Set<TransitionListener>();
  private stuckTimer: ReturnType<typeof setInterval> | null = null;

  // ── 查询 ────────────────────────────────────────────────────────

  hasActive(): boolean {
    for (const s of this.sessions.values()) {
      if (s.status === 'running' || s.status === 'aborting') return true;
    }
    return false;
  }

  getActiveSourceId(): string | null {
    for (const s of this.sessions.values()) {
      if (s.status === 'running' || s.status === 'aborting') return s.sourceId;
    }
    return null;
  }

  snapshot(sourceId: string): InitSessionSnapshot | null {
    const s = this.sessions.get(sourceId);
    if (!s) return null;
    return this.toSnapshot(s);
  }

  // ── 控制 ────────────────────────────────────────────────────────

  start(args: StartArgs): StartResult {
    const active = this.getActiveSourceId();
    if (active && active !== args.sourceId) {
      return { ok: false, reason: 'another_running', activeSourceId: active };
    }

    // 同一 sourceId 在 running / aborting 也拒绝（必须先 abort 完成）
    const existing = this.sessions.get(args.sourceId);
    if (existing && (existing.status === 'running' || existing.status === 'aborting')) {
      return { ok: false, reason: 'another_running', activeSourceId: args.sourceId };
    }

    const controller = new AbortController();
    const session: InitSessionInternal = {
      sourceId: args.sourceId,
      toolType: args.toolType,
      status: 'idle',  // 先放 idle，立即 transition 到 running
      progress: { ...DEFAULT_PROGRESS, startedAt: now() },
      error: null,
      abortReason: null,
      report: null,
      controller,
      promise: null,
      startedAt: Date.now(),
      endedAt: null,
      lastTransitionAt: Date.now(),
    };
    this.sessions.set(args.sourceId, session);

    // 启动 runner，wrap 终态处理
    const ctx = this.buildContext(session);
    const runPromise = (async () => {
      try {
        const report = await args.runner(ctx);
        // runner 结束时检查 signal——若已 abort 但 runner 不抛错（业务层未响应），仍记为 aborted
        if (session.controller && session.controller.signal.aborted) {
          this.transition(session, 'aborted', {
            abortReason: session.abortReason ?? 'user',
            endedAt: Date.now(),
          });
          return;
        }
        this.transition(session, 'done', { report, endedAt: Date.now() });
      } catch (err) {
        if (this.isAbortError(err)) {
          this.transition(session, 'aborted', {
            abortReason: session.abortReason ?? this.extractReason(err) ?? 'user',
            endedAt: Date.now(),
          });
        } else {
          const msg = (err instanceof Error) ? err.message : String(err);
          this.transition(session, 'error', { error: msg, endedAt: Date.now() });
        }
      }
    })();
    session.promise = runPromise;

    this.transition(session, 'running');
    this.ensureStuckMonitor();
    return { ok: true, snapshot: this.toSnapshot(session) };
  }

  /**
   * 中断会话。等业务 promise settle（最长 10 秒）后返回。
   * 返回时 snapshot.status 必定是 aborted / error / done 之一（不会是 aborting）。
   */
  async abort(sourceId: string, reason: AbortReason): Promise<InitSessionSnapshot> {
    const s = this.sessions.get(sourceId);
    if (!s) {
      // 不存在的会话，幂等返回 null-ish 快照
      return this.makeOrphanSnapshot(sourceId);
    }
    // 已是终态，幂等返回
    if (s.status === 'aborted' || s.status === 'error' || s.status === 'done' || s.status === 'idle') {
      return this.toSnapshot(s);
    }

    if (s.status === 'running') {
      this.transition(s, 'aborting', { abortReason: reason });
      try {
        s.controller?.abort(new InitAbortError(reason));
      } catch (e) {
        log.warn(`controller.abort threw for ${sourceId}: ${(e as Error).message}`);
      }
    }
    // status === 'aborting'：可能是上一次已 abort 但还在等

    // 等业务 promise settle，最长 10s
    const promise = s.promise;
    if (promise) {
      const winner = await Promise.race([
        promise.then(() => 'settled' as const).catch(() => 'settled' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ABORT_SETTLE_TIMEOUT_MS)),
      ]);
      if (winner === 'timeout') {
        log.warn(`abort timeout for ${sourceId}: forcing aborted state`);
        this.transition(s, 'aborted', {
          abortReason: reason,
          error: '业务层在 10 秒内未响应中断信号（已强制标记为 aborted）',
          endedAt: Date.now(),
        });
      }
    } else {
      // 没有 promise（不应发生），直接强转
      this.transition(s, 'aborted', { abortReason: reason, endedAt: Date.now() });
    }

    return this.toSnapshot(s);
  }

  /**
   * 清空 session 数据。仅在终态可调用。
   * 调用方负责调 rollbackNoteSource 删数据库行。
   */
  discard(sourceId: string): void {
    const s = this.sessions.get(sourceId);
    if (!s) return;
    if (s.status === 'running' || s.status === 'aborting') {
      throw new Error(`cannot discard a ${s.status} session; call abort first`);
    }
    this.sessions.delete(sourceId);
  }

  // ── 业务层调用 ──────────────────────────────────────────────────

  private buildContext(session: InitSessionInternal): InitSessionContext {
    return {
      sourceId: session.sourceId,
      signal: session.controller!.signal,
      reportPhase: (phase, name, total) => {
        this.updateProgress(session, { phase, phaseName: name, current: 0, total });
      },
      advance: (delta = 1) => {
        this.updateProgress(session, { current: session.progress.current + delta });
      },
      setProgress: (patch) => {
        this.updateProgress(session, patch);
      },
      heartbeat: () => {
        session.lastTransitionAt = Date.now();
      },
    };
  }

  private updateProgress(session: InitSessionInternal, patch: Partial<InitProgress>): void {
    if (session.status === 'done' || session.status === 'error' || session.status === 'aborted' || session.status === 'idle') {
      return;  // 终态后忽略业务上报
    }
    session.progress = { ...session.progress, ...patch };
    session.lastTransitionAt = Date.now();
    this.emit(session);
  }

  // ── 订阅 ────────────────────────────────────────────────────────

  on(event: 'transition', listener: TransitionListener): () => void {
    if (event !== 'transition') {
      throw new Error(`unknown event: ${event}`);
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private transition(
    session: InitSessionInternal,
    next: SessionStatus,
    patch: Partial<Pick<InitSessionInternal, 'error' | 'abortReason' | 'report' | 'endedAt'>> = {},
  ): void {
    session.status = next;
    if (patch.error !== undefined) session.error = patch.error;
    if (patch.abortReason !== undefined) session.abortReason = patch.abortReason;
    if (patch.report !== undefined) session.report = patch.report;
    if (patch.endedAt !== undefined) session.endedAt = patch.endedAt;
    session.lastTransitionAt = Date.now();
    if (next === 'aborted' || next === 'error' || next === 'done') {
      session.controller = null;
      session.promise = null;
    }
    this.emit(session);
    if (next === 'aborted' || next === 'error' || next === 'done') {
      this.maybeStopStuckMonitor();
    }
  }

  private emit(session: InitSessionInternal): void {
    const snap = this.toSnapshot(session);
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch (err) {
        log.warn(`listener threw: ${(err as Error).message}`);
      }
    }
  }

  private toSnapshot(s: InitSessionInternal): InitSessionSnapshot {
    return {
      sourceId: s.sourceId,
      toolType: s.toolType,
      status: s.status,
      progress: { ...s.progress },
      error: s.error,
      abortReason: s.abortReason,
      report: s.report ? { ...s.report } : null,
      canStart: s.status === 'idle' || s.status === 'aborted' || s.status === 'error',
      canAbort: s.status === 'running',
      canDiscard:
        (s.status === 'aborted' || s.status === 'error' || s.status === 'done') ||
        (s.status === 'idle' && s.endedAt !== null),
    };
  }

  private makeOrphanSnapshot(sourceId: string): InitSessionSnapshot {
    return {
      sourceId,
      toolType: 'logseq',  // 占位；调用方通常不会读
      status: 'idle',
      progress: { ...DEFAULT_PROGRESS },
      error: null,
      abortReason: null,
      report: null,
      canStart: true,
      canAbort: false,
      canDiscard: false,
    };
  }

  // ── stuck 检测 ───────────────────────────────────────────────

  private ensureStuckMonitor(): void {
    if (this.stuckTimer) return;
    this.stuckTimer = setInterval(() => this.checkStuckSessions(), STUCK_CHECK_INTERVAL_MS);
    // 不阻止 Node 进程退出
    if (typeof (this.stuckTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.stuckTimer as unknown as { unref: () => void }).unref();
    }
  }

  private maybeStopStuckMonitor(): void {
    if (!this.stuckTimer) return;
    if (!this.hasActive()) {
      clearInterval(this.stuckTimer);
      this.stuckTimer = null;
    }
  }

  private checkStuckSessions(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.status !== 'running') continue;
      const phase = session.progress.phase;
      const threshold = STUCK_THRESHOLD_MS_BY_PHASE[phase] ?? STUCK_THRESHOLD_MS_BY_PHASE[-1];
      const idleMs = now - session.lastTransitionAt;
      if (idleMs > threshold) {
        log.warn(`stuck detected for ${session.sourceId}: phase=${phase} idle=${Math.round(idleMs / 1000)}s threshold=${Math.round(threshold / 1000)}s`);
        // 异步触发 abort('stuck')，不阻塞 timer
        void this.abort(session.sourceId, 'stuck').catch((e) => {
          log.warn(`stuck abort failed for ${session.sourceId}: ${(e as Error).message}`);
        });
      }
    }
  }

  private isAbortError(err: unknown): boolean {
    if (err instanceof InitAbortError) return true;
    if (err instanceof Error) {
      // Anthropic / OpenAI / fetch AbortController 抛的常见名字
      if (err.name === 'AbortError' || err.name === 'InitAbortError') return true;
      // Web AbortSignal 抛 DOMException with name 'AbortError'
      if ((err as { name?: string }).name === 'AbortError') return true;
    }
    return false;
  }

  private extractReason(err: unknown): AbortReason | null {
    if (err instanceof InitAbortError) return err.reason;
    return null;
  }
}

// ── 单例 ──────────────────────────────────────────────────────────

export const initSessionManager = new InitSessionManager();
