/**
 * bfsEngine.ts  ─  LSP BFS エンジン
 *
 * lspBfs() で outgoing / incoming 両方向の BFS を統一的に処理する。
 * wsRoots ガード（shouldIncludeCallee）はこの関数内の 1 箇所にのみ記述する。
 */

import * as vscode from 'vscode';
import { GraphNode } from './types';
import {
  NodeIndex,
  BATCH_SIZE, BATCH_DELAY_INIT,
  checkCancellation, execWithRetry,
  makeNodeId, baseNameOf, addToNodeIndex,
  findExistingCalleeId, shouldIncludeCallee,
  nextAdaptiveDelay, delay,
  Pct,
} from './utils';

function updateNodeFromItem(node: GraphNode, item: vscode.CallHierarchyItem): void {
  // B10修正: item がノードの実ファイルと異なる場合は更新しない。
  // findExistingCalleeId のヘッダ用フォールバックで別ファイルのノードIDが
  // 誤って返された場合に、既存ノードの line/scopeEnd がヘッダ側の行番号で
  // 上書きされてしまうのを防ぐ(通常の同一ファイル内更新には影響しない)。
  if (item.uri.fsPath !== node.file) return;
  const definitionLine = item.range.end.line > item.selectionRange.start.line;
  const currentDefinition = (node.scopeEnd ?? node.line) > node.line;
  if (definitionLine && !currentDefinition) {
    node.line = item.selectionRange.start.line + 1;
    node.scopeEnd = item.range.end.line + 1;
    node.labelFull = item.name;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BFS 共通インターフェース
// ─────────────────────────────────────────────────────────────────────────────

export interface BfsResult {
  edgeSet: Set<string>;
  errs:    string[];
}

/**
 * BfsResult を呼び出し元の edgeSet / errs にマージするユーティリティ。
 */
export function mergeBfsResult(
  target: { edgeSet: Set<string>; errs: string[] },
  result: BfsResult,
): void {
  result.edgeSet.forEach(e => target.edgeSet.add(e));
  target.errs.push(...result.errs);
}


// LSP BFS エンジン
// ─────────────────────────────────────────────────────────────────────────────

export interface LspBfsOptions {
  direction:  'outgoing' | 'incoming';

  /** BFS の起点。[CallHierarchyItem, nodeId] のペア配列。 */
  startItems: Array<[vscode.CallHierarchyItem, string]>;

  /**
   * 呼び出し元の nodes / nodeIndex。エンジンはこれを直接変異させる。
   * 下方向 BFS の結果を上方向 BFS に引き継ぐため、両 BFS で同一の Map を渡す。
   */
  nodes:     Map<string, GraphNode>;
  nodeIndex: NodeIndex;

  currentFile: string;
  wsRoots:     string[];

  /** undefined = 深さ無制限 */
  maxHops?: number;

  token?:    vscode.CancellationToken;
  pct:       Pct;
  pctRange:  [number, number];
}

/**
 * LSP 汎用 BFS エンジン。
 *
 * direction:'outgoing' → provideOutgoingCalls を使いコールツリーを下方向に展開する。
 * direction:'incoming' → provideIncomingCalls を使いコールツリーを上方向に遡る。
 *
 * wsRoots ガード（shouldIncludeCallee / wsRoots.length===0 チェック）は
 * この関数内の 1 箇所にのみ記述する。
 * adaptiveDelay / streak はこの関数内部に閉じ込める（呼び出し元には見えない）。
 */
export async function lspBfs(opts: LspBfsOptions): Promise<BfsResult> {
  const {
    direction, startItems, nodes, nodeIndex,
    currentFile, wsRoots, maxHops, token, pct, pctRange,
  } = opts;

  type QItem = [vscode.CallHierarchyItem, string, number]; // [item, nodeId, hop]
  const queue:   QItem[]      = [];
  const visited  = new Set<string>();
  const queued   = new Set<string>();
  const edgeSet  = new Set<string>();
  const errs:    string[]     = [];
  let   adaptiveDelay         = BATCH_DELAY_INIT;
  const streak                = { val: 0 };

  // 起点をキューに投入
  for (const [item, nodeId] of startItems) {
    if (!queued.has(nodeId)) {
      queued.add(nodeId);
      queue.push([item, nodeId, 0]);
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    checkCancellation(token);

    // BATCH_SIZE 個分のバッチを取り出す
    type BatchItem = { item: vscode.CallHierarchyItem; nodeId: string; hop: number };
    const batch: BatchItem[] = [];
    while (batch.length < BATCH_SIZE && qi < queue.length) {
      const [item, nodeId, hop] = queue[qi++];
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      // ノードが未登録なら登録する（コアノードは呼び出し元が事前登録済み）
      if (!nodes.has(nodeId)) {
        const newNode: GraphNode = {
          id:            nodeId,
          label:         baseNameOf(item.name),
          labelFull:     item.name,
          file:          item.uri.fsPath,
          line:          item.selectionRange.start.line + 1,
          scopeEnd:      item.range.end.line + 1,
          isCurrentFile: item.uri.fsPath === currentFile,
        };
        nodes.set(nodeId, newNode);
        addToNodeIndex(nodeIndex, nodeId, newNode);
      } else {
        updateNodeFromItem(nodes.get(nodeId)!, item);
      }

      // maxHops 到達済みのノードは展開しない（登録だけ行う）
      if (maxHops === undefined || hop < maxHops) {
        batch.push({ item, nodeId, hop });
      }
    }
    if (batch.length === 0) continue;

    // バッチを並列で LSP 呼び出し
    let errorsInBatch = 0;
    const batchResults = await Promise.all(batch.map(async ({ item, nodeId, hop }) => {
      try {
        if (direction === 'outgoing') {
          const calls = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
            'vscode.provideOutgoingCalls', token, item);
          return { nodeId, hop, outgoing: calls ?? [], incoming: [] as vscode.CallHierarchyIncomingCall[] };
        } else {
          const calls = await execWithRetry<vscode.CallHierarchyIncomingCall[]>(
            'vscode.provideIncomingCalls', token, item);
          return { nodeId, hop, outgoing: [] as vscode.CallHierarchyOutgoingCall[], incoming: calls ?? [] };
        }
      } catch (err) {
        if (err instanceof vscode.CancellationError) throw err;
        errorsInBatch++;
        errs.push(`${item.name}: ${String(err)}`);
        return {
          nodeId, hop,
          outgoing: [] as vscode.CallHierarchyOutgoingCall[],
          incoming: [] as vscode.CallHierarchyIncomingCall[],
        };
      }
    }));

    // 結果を処理してノード登録・エッジ追加・次ホップをキューに積む
    for (const { nodeId, hop, outgoing, incoming } of batchResults) {
      // ── 下方向: nodeId は caller, to は callee ──────────────────────────
      for (const call of outgoing) {
        const { to } = call;
        let calleeId = findExistingCalleeId(nodes, nodeIndex, to);
        if (!calleeId) {
          // wsRoots ガード: shouldIncludeCallee は wsRoots=[] で常に false (安全側)
          if (!shouldIncludeCallee(to.uri, wsRoots)) continue;
          calleeId = makeNodeId(to.uri, to.name);
          if (!nodes.has(calleeId)) {
            const calleeNode: GraphNode = {
              id:            calleeId,
              label:         baseNameOf(to.name),
              labelFull:     to.name,
              file:          to.uri.fsPath,
              line:          to.selectionRange.start.line + 1,
              scopeEnd:      to.range.end.line + 1,
              isCurrentFile: to.uri.fsPath === currentFile,
            };
            nodes.set(calleeId, calleeNode);
            addToNodeIndex(nodeIndex, calleeId, calleeNode);
          }
        }
        edgeSet.add(`${nodeId}|||${calleeId}`);
        if (!queued.has(calleeId)) {
          queued.add(calleeId);
          queue.push([to, calleeId, hop + 1]);
        }
      }

      // ── 上方向: nodeId は callee, from は caller ────────────────────────
      for (const call of incoming) {
        let callerId = findExistingCalleeId(nodes, nodeIndex, call.from);
        if (!callerId) {
          // outgoing と同じく shouldIncludeCallee でガード（isInWorkspace + 拡張子チェック）
          if (!shouldIncludeCallee(call.from.uri, wsRoots)) continue;
          callerId = makeNodeId(call.from.uri, call.from.name);
        }
        if (!nodes.has(callerId)) {
          const callerNode: GraphNode = {
            id:            callerId,
            label:         baseNameOf(call.from.name),
            labelFull:     call.from.name,
            file:          call.from.uri.fsPath,
            line:          call.from.selectionRange.start.line + 1,
            scopeEnd:      call.from.range.end.line + 1,
            isCurrentFile: call.from.uri.fsPath === currentFile,
          };
          nodes.set(callerId, callerNode);
          addToNodeIndex(nodeIndex, callerId, callerNode);
        }
        // エッジ方向: caller → callee
        edgeSet.add(`${callerId}|||${nodeId}`);
        if (!queued.has(callerId)) {
          queued.add(callerId);
          queue.push([call.from, callerId, hop + 1]);
        }
      }
    }

    // adaptiveDelay と進捗更新（内部クローズ）
    adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, errorsInBatch > 0, streak);
    pct.bfsQ(pctRange[0], pctRange[1], queued, { length: queue.length - qi });
    if (adaptiveDelay > 0 && qi < queue.length) await delay(adaptiveDelay);
  }

  return { edgeSet, errs };
}