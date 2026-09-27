/**
 * lspBackend.ts  ─  LSP バックエンド実装
 *
 * Language Server Protocol (clangd 等) を使ったコールグラフ構築。
 * lspBfs エンジンを呼び出す薄いオーケストレーター層。
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { GraphNode, GraphData } from './types';
import {
  mergeBfsResult, lspBfs,
} from './bfsEngine';
import {
  Pct, checkCancellation, execWithRetry, isCanceledByClangd,
  NodeIndex,
  makeNodeId, baseNameOf, addToNodeIndex, flattenFunctions,
  splitEdges, getWorkspaceRoots, hasCppSourceExtension,
  BATCH_SIZE, CANCELED_RETRY_DELAY, delay,
} from './utils';

function isDefinitionItem(item: vscode.CallHierarchyItem): boolean {
  return item.range.end.line > item.selectionRange.start.line;
}

function preferDefinitionItem(
  current: vscode.CallHierarchyItem | undefined,
  candidate: vscode.CallHierarchyItem,
): vscode.CallHierarchyItem {
  if (!current) return candidate;
  if (isDefinitionItem(candidate) && !isDefinitionItem(current)) return candidate;
  return current;
}

export async function buildFileCallGraphLsp(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0      = Date.now();
  const errs:   string[] = [];
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct     = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  const rawSyms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider', document.uri);
  if (!rawSyms?.length) throw new Error(
    'No symbols found in this file.\nCheck that the language server is running.');

  const functions = flattenFunctions(rawSyms);
  if (!functions.length) throw new Error('No function symbols found in this file.');

  const nodes:     Map<string, GraphNode> = new Map();
  const edgeSet:   Set<string>            = new Set();
  const nodeIndex: NodeIndex              = new Map();

  // コアノードを事前登録
  for (const f of functions) {
    const id = makeNodeId(document.uri, f.name);
    const n: GraphNode = {
      id, label: baseNameOf(f.name), labelFull: f.name,
      file: document.uri.fsPath, line: f.selectionRange.start.line + 1,
      scopeEnd: f.range.end.line + 1, isCurrentFile: true,
    };
    nodes.set(id, n);
    addToNodeIndex(nodeIndex, id, n);
  }

  // prepareCallHierarchy (バッチ並列)
  pct.to(5);
  const coreItems = new Map<string, vscode.CallHierarchyItem>();
  for (let i = 0; i < functions.length; i += BATCH_SIZE) {
    checkCancellation(token);
    await Promise.all(functions.slice(i, i + BATCH_SIZE).map(async f => {
      const id = makeNodeId(document.uri, f.name);
      try {
        const items = await execWithRetry<vscode.CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy', token, document.uri, f.selectionRange.start);
        if (items?.[0]) coreItems.set(id, preferDefinitionItem(coreItems.get(id), items[0]));
      } catch (err) {
        if (err instanceof vscode.CancellationError) throw err;
        errs.push(`(prep) ${f.name}: ${String(err)}`);
      }
    }));
    pct.range(5, 20, Math.min(i + BATCH_SIZE, functions.length), functions.length);
  }

  // 発信・着信 BFS を並列実行。
  // 両者は nodes/nodeIndex を共有するが、ノード登録(has→set)は
  // await を挟まず同期的に完結しているため競合しない。
  const [downResult, upResult] = await Promise.all([
    lspBfs({
      direction: 'outgoing', startItems: Array.from(coreItems, ([id, item]) => [item, id]),
      nodes, nodeIndex, currentFile: document.uri.fsPath, wsRoots,
      token, pct, pctRange: [20, 60],
    }),
    lspBfs({
      direction: 'incoming', startItems: Array.from(coreItems, ([id, item]) => [item, id]),
      nodes, nodeIndex, currentFile: document.uri.fsPath, wsRoots,
      token, pct, pctRange: [60, 100],
    }),
  ]);
  mergeBfsResult({ edgeSet, errs }, downResult);
  mergeBfsResult({ edgeSet, errs }, upResult);

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName:    path.basename(document.uri.fsPath),
    buildTimeMs: Date.now() - t0, errors: errs,
  };
}

export async function buildFunctionCallGraphLsp(
  document: vscode.TextDocument, position: vscode.Position, maxHops: number | undefined,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0      = Date.now();
  const errs:   string[] = [];
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct     = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  const startItems = await execWithRetry<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy', token, document.uri, position);
  if (!startItems?.length) throw new Error(
    'No function found at cursor position.\nPlace the cursor on a function name and try again.');

  const nodes:     Map<string, GraphNode> = new Map();
  const edgeSet:   Set<string>            = new Set();
  const nodeIndex: NodeIndex              = new Map();
  const startNodeId = makeNodeId(startItems[0].uri, startItems[0].name);

  // 下方向 BFS のみ
  mergeBfsResult({ edgeSet, errs }, await lspBfs({
    direction: 'outgoing',
    startItems: [[startItems[0], startNodeId]],
    nodes, nodeIndex, currentFile: document.uri.fsPath, wsRoots,
    maxHops, token, pct, pctRange: [5, 100],
  }));

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName:    `${baseNameOf(startItems[0].name)} (${path.basename(document.uri.fsPath)})`,
    buildTimeMs: Date.now() - t0, errors: errs,
  };
}

export async function buildPathThroughCallGraphLsp(
  document: vscode.TextDocument, position: vscode.Position, maxHops: number | undefined,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0      = Date.now();
  const errs:   string[] = [];
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct     = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  const startItems = await execWithRetry<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy', token, document.uri, position);
  if (!startItems?.length) throw new Error(
    'No function found at cursor position.\nPlace the cursor on a function name and try again.');

  const nodes:     Map<string, GraphNode> = new Map();
  const edgeSet:   Set<string>            = new Set();
  const nodeIndex: NodeIndex              = new Map();
  const startNodeId = makeNodeId(startItems[0].uri, startItems[0].name);
  const startEntry: [vscode.CallHierarchyItem, string] = [startItems[0], startNodeId];

  // 発信・着信 BFS を並列実行(理由は buildFileCallGraphLsp と同様)。
  const [downResult, upResult] = await Promise.all([
    lspBfs({
      direction: 'outgoing', startItems: [startEntry],
      nodes, nodeIndex, currentFile: document.uri.fsPath, wsRoots,
      maxHops, token, pct, pctRange: [5, 52],
    }),
    lspBfs({
      direction: 'incoming', startItems: [startEntry],
      nodes, nodeIndex, currentFile: document.uri.fsPath, wsRoots,
      maxHops, token, pct, pctRange: [52, 100],
    }),
  ]);
  mergeBfsResult({ edgeSet, errs }, downResult);
  mergeBfsResult({ edgeSet, errs }, upResult);

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName:    `↕ ${baseNameOf(startItems[0].name)} (${path.basename(document.uri.fsPath)})`,
    buildTimeMs: Date.now() - t0, errors: errs,
  };
}

/**
 * 1 ファイル分の outgoing calls を処理するヘルパー。
 * prepareCallHierarchy → lspBfs (maxHops=1) の順で実行する。
 * Canceled エラーになった関数を返す（呼び出し元でリトライ可能）。
 * adaptiveDelay は lspBfs エンジン内部に閉じ込める。
 */
export async function processWsFileLsp(
  uri:       vscode.Uri,
  functions: vscode.DocumentSymbol[],
  nodes:     Map<string, GraphNode>,
  nodeIndex: NodeIndex,
  edgeSet:   Set<string>,
  errs:      string[],
  wsRoots:   string[],
  token?:    vscode.CancellationToken,
  pct:       Pct = new Pct(),
  pctRange:  [number, number] = [0, 100],
): Promise<vscode.DocumentSymbol[]> {
  const canceledFuncs: vscode.DocumentSymbol[] = [];
  const startItems = new Map<string, vscode.CallHierarchyItem>();

  for (let i = 0; i < functions.length; i += BATCH_SIZE) {
    checkCancellation(token);
    await Promise.all(functions.slice(i, i + BATCH_SIZE).map(async f => {
      try {
        const items = await execWithRetry<vscode.CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy', token, uri, f.selectionRange.start);
        if (items?.[0]) {
          const id = makeNodeId(uri, f.name);
          startItems.set(id, preferDefinitionItem(startItems.get(id), items[0]));
        }
      } catch (err) {
        if (err instanceof vscode.CancellationError) throw err;
        if (isCanceledByClangd(err)) canceledFuncs.push(f);
        else errs.push(`${path.basename(uri.fsPath)}::${f.name}: ${String(err)}`);
      }
    }));
  }

  if (startItems.size > 0) {
    mergeBfsResult({ edgeSet, errs }, await lspBfs({
      direction: 'outgoing',
      startItems: Array.from(startItems, ([id, item]) => [item, id]),
      nodes, nodeIndex,
      currentFile: uri.fsPath, wsRoots,
      maxHops: 1, token, pct, pctRange,
    }));
  }
  return canceledFuncs;
}

export async function buildWorkspaceCallGraphLsp(
  uris:      vscode.Uri[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0          = Date.now();
  const errs:       string[] = [];
  const FILE_PARALLEL = 3;
  const uniqueUris  = Array.from(new Map(uris.map(u => [u.fsPath, u])).values())
    .filter(u => hasCppSourceExtension(u));
  if (!uniqueUris.length) throw new Error('No C/C++ source files found.');

  const wsRoots   = getWorkspaceRoots(uniqueUris[0]);
  const nodes:     Map<string, GraphNode> = new Map();
  const edgeSet:   Set<string>            = new Set();
  const nodeIndex: NodeIndex              = new Map();
  const pct       = new Pct(progress);

  // フェーズ1: シンボル取得 + ノード事前登録 (FILE_PARALLEL 並列)
  type FileEntry = { uri: vscode.Uri; functions: vscode.DocumentSymbol[] };
  const fileEntries: FileEntry[] = [];
  for (let si = 0; si < uniqueUris.length; si += FILE_PARALLEL) {
    checkCancellation(token);
    await Promise.all(uniqueUris.slice(si, si + FILE_PARALLEL).map(async uri => {
      let rawSyms: vscode.DocumentSymbol[] | undefined;
      try {
        rawSyms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider', uri);
      } catch { return; }
      if (!rawSyms?.length) return;
      const functions = flattenFunctions(rawSyms);
      for (const f of functions) {
        const id = makeNodeId(uri, f.name);
        if (!nodes.has(id)) {
          const n: GraphNode = {
            id, label: baseNameOf(f.name), labelFull: f.name,
            file: uri.fsPath, line: f.selectionRange.start.line + 1,
            scopeEnd: f.range.end.line + 1, isCurrentFile: false,
          };
          nodes.set(id, n);
          addToNodeIndex(nodeIndex, id, n);
        }
      }
      fileEntries.push({ uri, functions });
    }));
    pct.range(0, 40, Math.min(si + FILE_PARALLEL, uniqueUris.length), uniqueUris.length);
  }

  // フェーズ2: ファイル単位で outgoing calls を処理 (FILE_PARALLEL 並列)
  const canceledFuncsByFile = new Map<string, { uri: vscode.Uri; funcs: vscode.DocumentSymbol[] }>();
  for (let fi = 0; fi < fileEntries.length; fi += FILE_PARALLEL) {
    checkCancellation(token);
    pct.range(40, 95, fi, fileEntries.length);
    await Promise.all(fileEntries.slice(fi, fi + FILE_PARALLEL).map(async ({ uri, functions }) => {
      const canceled = await processWsFileLsp(
        uri, functions, nodes, nodeIndex, edgeSet, errs, wsRoots, token);
      if (canceled.length > 0) canceledFuncsByFile.set(uri.fsPath, { uri, funcs: canceled });
    }));
  }

  // clangd Canceled リトライ
  if (canceledFuncsByFile.size > 0) {
    await delay(CANCELED_RETRY_DELAY);
    checkCancellation(token);
    for (const { uri, funcs } of canceledFuncsByFile.values()) {
      checkCancellation(token);
      const stillFailed = await processWsFileLsp(
        uri, funcs, nodes, nodeIndex, edgeSet, errs, wsRoots, token);
      for (const f of stillFailed) {
        errs.push(`${path.basename(uri.fsPath)}::${f.name}: Canceled (retry failed)`);
      }
    }
  }

  pct.to(100);
  const label = uniqueUris.length === 1
    ? path.basename(uniqueUris[0].fsPath)
    : `${uniqueUris.length} files`;
  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: label, buildTimeMs: Date.now() - t0, errors: errs,
  };
}