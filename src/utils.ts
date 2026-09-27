/**
 * utils.ts  ─  共有ユーティリティ
 *
 * 依存関係: types.ts, cacheManager.ts, vscode, path, fs
 * このファイルはビジネスロジック（BFS・ビルド処理）を持たない。
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import { GraphNode, GraphEdge, ScopeEntry, ScopeMapEntry } from './types';
import { cache } from './cacheManager';

// ─────────────────────────────────────────────────────────────────────────────
// 型
// ─────────────────────────────────────────────────────────────────────────────

/** ファイル+baseName → nodeId の O(1) ルックアップインデックス */
export type NodeIndex = Map<string, string>;

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

export const CC_SOURCE_EXTENSIONS = new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh']);
export const CC_CALLEE_EXTENSIONS  = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.c++',
  '.h', '.hh', '.hpp', '.hxx', '.h++',
  '.inl', '.ipp', '.tpp', '.tcc',
  // B4修正: CC_SOURCE_EXTENSIONS(解析対象として選択できるファイル)には .cu/.cuh が
  // 含まれるが、こちらに無かったため、CUDAファイル内の関数がコールグラフのcallee側
  // (LSPバックエンドの shouldIncludeCallee)として一切拾われず、エッジが消えていた。
  '.cu', '.cuh',
]);

/**
 * 解析・変更検知の対象から除外するディレクトリ名。
 * extension.ts のファイルウォッチャー(isExcludedPath)と、gtagsBackend.ts の
 * candidateRank(N1: 同名候補の距離判定で除外ディレクトリ配下の候補を後回しにする)
 * で共有する。両者で別々に定義すると片方だけ更新されるリスクがあるため一元化した。
 */
export const EXCLUDE_DIRS = new Set([
  // 共通
  'node_modules', 'build', 'dist', 'out', '.git',
  // CMake 系
  'CMakeFiles', '_build', '_deps', 'cmake-build-debug', 'cmake-build-release',
  // ツール系
  '.cache', '.ccls-cache', 'vendor', '.deps',
  // Python 系 (C/C++ プロジェクトに Python ビルドスクリプト等が同居するケース用。
  // 以前は gtagsBackend.ts の EXCLUDE_GLOB にのみ個別定義されており、こちらの
  // isExcludedPath / candidateRank 側には反映されていなかった)
  '__pycache__', '.venv', '.mypy_cache',
]);

export const BATCH_SIZE           = 6;
export const BATCH_DELAY_INIT     = 20;
export const MAX_RETRY            = 4;
export const RETRY_BASE_MS        = 200;
export const CANCELED_RETRY_DELAY = 3000;

// ─────────────────────────────────────────────────────────────────────────────
// 汎用ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeFsPath(p: string): string {
  const n = path.normalize(p);
  // #2修正: 以前は win32 のみを大文字小文字非依存として扱っていたが、macOS(darwin)の
  // 標準ファイルシステム(APFS/HFS+)も既定で大文字小文字を区別しない。
  // webviewPanel.ts の resolveAndNormalize、および本ファイル内 getScopeIndex の
  // 「非linux小文字索引」フォールバックはすでに darwin も対象にしており、
  // ここだけ win32 限定になっていた不整合を解消する。
  return process.platform !== 'linux' ? n.toLowerCase() : n;
}

export function splitEdges(edgeSet: Set<string>): GraphEdge[] {
  return Array.from(edgeSet).map(key => {
    const sep = key.indexOf('|||');
    return { from: key.slice(0, sep), to: key.slice(sep + 3) };
  });
}

export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return h.toString(16).padStart(8, '0');
}

export function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function nextAdaptiveDelay(
  current:  number,
  hadError: boolean,
  streak:   { val: number },
): number {
  if (hadError) { streak.val = 0; return Math.min(current + 50, 500); }
  streak.val++;
  if (streak.val >= 3) { streak.val = 0; return Math.max(0, Math.floor(current / 2)); }
  return current;
}

export function checkCancellation(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
}

export function isCanceledByClangd(err: unknown): boolean {
  return !(err instanceof vscode.CancellationError) && String(err).includes('Canceled');
}

// VS Code がコマンド自体未登録の場合に投げるエラーメッセージの形式は `command '<id>' not found`
// (例: "Error: command 'vscode.provideOutgoingCalls' not found")。
// 単純に 'not found' という部分文字列だけで判定すると、clangd/cpptools がインデックス未完了時に
// 返す一時的なエラー(例: "symbol not found" 系の文言)まで巻き込んで即座に諦めてしまい、
// 本来リトライで解決したはずの一時的な失敗を悪化させてしまう。
// そのため「command '...' not found」という構造そのものにマッチする場合のみ早期に諦める。
const COMMAND_NOT_FOUND_RE = /\bcommand\s+'[^']*'\s+not found\b/i;

export async function execWithRetry<T>(
  command: string,
  token:   vscode.CancellationToken | undefined,
  ...args: unknown[]
): Promise<T | undefined> {
  for (let i = 0; i < MAX_RETRY; i++) {
    checkCancellation(token);
    try {
      return await vscode.commands.executeCommand<T>(command, ...args);
    } catch (err) {
      if (err instanceof vscode.CancellationError) throw err;
      if (COMMAND_NOT_FOUND_RE.test(String(err))) throw err;
      if (i < MAX_RETRY - 1) { await delay(RETRY_BASE_MS * Math.pow(2, i)); continue; }
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ワークスペースルート
// ─────────────────────────────────────────────────────────────────────────────

export function getWorkspaceRoots(fallbackUri?: vscode.Uri): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  if (folders.length === 0 && fallbackUri) return [path.dirname(fallbackUri.fsPath)];
  return folders;
}

export function getWorkspaceRootForFile(fileUri: vscode.Uri): string | undefined {
  const filePath = normalizeFsPath(fileUri.fsPath);
  const folders  = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = normalizeFsPath(folder.uri.fsPath);
    if (filePath === root || filePath.startsWith(root + path.sep) || filePath.startsWith(root + '/'))
      return folder.uri.fsPath;
  }
  return folders[0]?.uri.fsPath ?? path.dirname(fileUri.fsPath);
}

export function hasCppSourceExtension(uri: vscode.Uri): boolean {
  return CC_SOURCE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// スコープ検索 (WeakMap キャッシュ付き O(1) 大文字小文字無視)
// ─────────────────────────────────────────────────────────────────────────────

// N9修正: 以前は「見つからない」場合に scopeMap の全キーを線形走査して
// normalizeFsPath をかけていたため、関数定義を持たないファイル(代表例: ヘッダ。
// 外部リンケージ関数のプロトタイプ参照のたびにこの経路を通る)に対する検索が
// ファイル数に比例して遅くなっていた(数千ファイル規模で顕著)。
// scopeMap の変更検知用バージョンカウンタ。
// getScopeIndex() は size の一致だけでキャッシュ有効性を判定していたが、
// 理論上「N件削除してN件追加」のような size 不変の変更があると stale なインデックスを
// 使い続けてしまう(現状は scopeMap 系はすべて追加専用のため実害はないが、将来の変更に対する
// 防御として、変更のたびに touchScopeMap() を呼んでもらうことでバージョンも照合する)。
// touchScopeMap() が呼ばれない場合は従来通り size のみでの判定にフォールバックするため、
// 呼び出し忘れがあっても現状より悪化することはない。
const scopeMapVersions = new WeakMap<Map<string, ScopeMapEntry>, number>();

/** scopeMap への .set()/削除等の変更後に呼び出し、getScopeIndex() のキャッシュを無効化する。 */
export function touchScopeMap(scopeMap: Map<string, ScopeMapEntry>): void {
  scopeMapVersions.set(scopeMap, (scopeMapVersions.get(scopeMap) ?? 0) + 1);
}

// 正規化済みキーの索引を scopeMap ごとに1回だけ構築し、以降は O(1) で引く。
// 「無い」と確定したパスも missing に記録して線形走査を再度走らせない。
// #2修正: normalizeFsPath が非linux(win32/darwin)で既に小文字化するようになったため、
// ここで別途 toLowerCase() していた「非linux小文字索引」フォールバックは不要になった
// (normalizeFsPath の結果がそのまま既に小文字なので、旧実装は同じキーを2回setするだけの
//  無駄な処理になっていた)。索引を1本化して単純化する。
interface ScopeIndex {
  size:    number;
  version: number;
  byNorm:  Map<string, ScopeMapEntry>;  // normalizeFsPath 済みキー → エントリ
  missing: Set<string>;                 // 「無い」と確定したパス
}
const scopeIndexCache = new WeakMap<Map<string, ScopeMapEntry>, ScopeIndex>();

function getScopeIndex(scopeMap: Map<string, ScopeMapEntry>): ScopeIndex {
  const currentVersion = scopeMapVersions.get(scopeMap) ?? 0;
  const cached = scopeIndexCache.get(scopeMap);
  if (cached && cached.size === scopeMap.size && cached.version === currentVersion) return cached;
  const byNorm = new Map<string, ScopeMapEntry>();
  for (const [k, v] of scopeMap) {
    const nk = normalizeFsPath(k);
    if (!byNorm.has(nk)) byNorm.set(nk, v);
  }
  const idx: ScopeIndex = { size: scopeMap.size, version: currentVersion, byNorm, missing: new Set() };
  scopeIndexCache.set(scopeMap, idx);
  return idx;
}

export function findScopeMapEntry(
  scopeMap: Map<string, ScopeMapEntry>,
  filePath: string,
): ScopeMapEntry | undefined {
  let entry = scopeMap.get(filePath);
  if (entry) return entry;
  const idx  = getScopeIndex(scopeMap);
  const norm = normalizeFsPath(filePath);
  entry = idx.byNorm.get(norm);
  if (entry) return entry;
  if (idx.missing.has(filePath)) return undefined;
  try {
    const real = cache.getRealpath(filePath) ?? (() => {
      const r = fs.realpathSync(filePath); cache.setRealpath(filePath, r); return r;
    })();
    entry = scopeMap.get(real) ?? idx.byNorm.get(normalizeFsPath(real));
    if (entry) return entry;
  } catch { /* ファイル不存在は無視 */ }
  idx.missing.add(filePath);
  return undefined;
}

export function findScopeAtLine(list: ScopeEntry[], refLine: number): ScopeEntry | undefined {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s   = list[mid];
    if      (refLine < s.start) hi = mid - 1;
    else if (refLine > s.end)   lo = mid + 1;
    else                        return s;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// LSP ノード操作ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeSymbolName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function makeNodeId(uri: vscode.Uri, name: string): string {
  return `${uri.fsPath}\x00${normalizeSymbolName(name)}`;
}

export function baseNameOf(name: string): string {
  // clangd の CallHierarchyItem.name は "Ns::Class::method(int, float)" の形で返ることがある。
  // まず "(" より前の部分だけ取り出してから :: を処理することで
  // 引数部分がラベルに混入するのを防ぐ。
  const parenIdx = name.indexOf('(');
  const base     = parenIdx >= 0 ? name.slice(0, parenIdx) : name;
  const colonIdx = base.lastIndexOf('::');
  return colonIdx >= 0 ? base.slice(colonIdx + 2) : base;
}

export function addToNodeIndex(index: NodeIndex, id: string, node: GraphNode): void {
  const key = `${node.file}\x00${node.label}`;
  if (!index.has(key)) index.set(key, id);
}

export function findExistingCalleeId(
  nodes: ReadonlyMap<string, GraphNode>,
  index: ReadonlyMap<string, string>,
  to:    vscode.CallHierarchyItem,
): string | null {
  const exactId = makeNodeId(to.uri, to.name);
  if (nodes.has(exactId)) return exactId;
  const base    = baseNameOf(to.name);
  const indexed = index.get(`${to.uri.fsPath}\x00${base}`);
  if (indexed) return indexed;
  const ext = path.extname(to.uri.fsPath).toLowerCase();
  // Bug修正: CC_CALLEE_EXTENSIONS のヘッダー拡張子(.h/.hh/.hpp/.hxx/.h++)と一致させる。
  // 以前は .hh/.h++ が抜けており、これらの拡張子のヘッダー経由で同名関数の曖昧さが
  // 生じた場合に限り、下記の stem一致/候補1件フォールバックが働かず callee が
  // 解決できずに edge が欠落していた。
  if (['.h', '.hh', '.hpp', '.hxx', '.h++'].includes(ext)) {
    // B10修正: 以前は「ラベルが一致する最初のノード」を無条件で採用しており、
    // 同名の別ファイルの static 関数などへ誤接続する可能性があった
    // (ヘッダのプロトタイプ経由で inline 関数や複数箇所にある同名シンボルを
    //  解決しようとした場合等)。
    // 候補を全て集め、① ヘッダと同じ stem(foo.h ↔ foo.c/.cpp等)を持つ
    // 候補があればそれを最優先で採用し、② stem一致が無い場合でも
    // 候補が1件だけ(曖昧さが無い)なら採用する。③ 複数候補があり
    // stem一致も無い場合は、どれが正しいか判別できないため統合しない。
    const stem = path.basename(to.uri.fsPath, ext);
    const candidates: string[] = [];
    let stemMatch: string | null = null;
    for (const [id, node] of nodes) {
      if (node.label === base || baseNameOf(node.label) === base) {
        candidates.push(id);
        if (path.basename(node.file, path.extname(node.file)) === stem) stemMatch = id;
      }
    }
    if (stemMatch) return stemMatch;
    if (candidates.length === 1) return candidates[0];
  }
  return null;
}

export function isInWorkspace(uri: vscode.Uri, roots: string[]): boolean {
  const fp = uri.fsPath;
  return roots.some(r => fp === r || fp.startsWith(r + '/') || fp.startsWith(r + path.sep));
}

export function shouldIncludeCallee(uri: vscode.Uri, roots: string[]): boolean {
  return isInWorkspace(uri, roots)
    && CC_CALLEE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

export function flattenFunctions(syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const KINDS = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
  ]);
  const seen = new Set<string>(); const result: vscode.DocumentSymbol[] = [];
  function walk(arr: vscode.DocumentSymbol[]) {
    for (const s of arr) {
      if (KINDS.has(s.kind)) {
        const key = `${s.selectionRange.start.line}:${baseNameOf(s.name)}`;
        if (!seen.has(key)) { seen.add(key); result.push(s); }
      }
      if (s.children?.length) walk(s.children);
    }
  }
  walk(syms); return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pct — 進捗ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

export class Pct {
  private cur = 0;
  constructor(private readonly p?: vscode.Progress<{ message?: string; increment?: number }>) {}

  private safeReport(msg: { message?: string; increment?: number }): void {
    if (this.p !== undefined && this.p !== null && typeof (this.p as any).report === 'function') {
      (this.p as vscode.Progress<{ message?: string; increment?: number }>).report(msg);
    }
  }

  to(val: number): void {
    const v = Math.min(100, Math.max(0, Math.round(val)));
    const d = v - this.cur;
    if (d > 0) {
      this.safeReport({ message: `${v}%`, increment: d });
      this.cur = v;
    }
  }
  range(start: number, end: number, pos: number, total: number): void {
    this.to(start + (end - start) * pos / Math.max(1, total));
  }
  bfsQ(start: number, end: number, touched: { size: number }, pending: { length: number }): void {
    const total = touched.size;
    const done  = Math.max(0, total - pending.length);
    this.to(total === 0 ? end : start + (end - start) * done / total);
  }
  report(message: string): void {
    this.safeReport({ message, increment: 0 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags ヘルパー (pure / ほぼ純粋)
// ─────────────────────────────────────────────────────────────────────────────

export function isLikelyFuncDef(line: string): boolean {
  const s = line.trim();
  if (!s || s.startsWith('#') || s.startsWith('}')) return false;
  if (s.includes('typedef') || !s.includes('(') || s.endsWith(';')) return false;
  if (/=\s*(0|delete|default)\s*[;,]?\s*$/.test(s)) return false;
  return true;
}

export function makeGtagsNodeId(file: string, name: string, line: number): string {
  return `${file}\x00${name}\x00${line}`;
}

export function parseGtagsNodeId(nodeId: string): { file: string; name: string; line: number } {
  const [file, name, lineStr] = nodeId.split('\x00');
  return { file, name, line: parseInt(lineStr, 10) };
}

export function escapeRegexForGlobal(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}