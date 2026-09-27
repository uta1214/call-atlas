/**
 * callGraphBuilder.ts  ─  公開エントリーポイント
 *
 * LSP / gtags バックエンドを backend 引数で切り替えてグラフを構築する。
 * キャッシュ管理・バックエンド解決のみ担当し、BFS ロジックは各バックエンドに委譲する。
 */

import * as vscode   from 'vscode';
import * as path     from 'path';
import { cache }     from './cacheManager';
import {
  buildFileCallGraphLsp,
  buildFunctionCallGraphLsp,
  buildWorkspaceCallGraphLsp,
  buildPathThroughCallGraphLsp,
} from './lspBackend';
import {
  buildFileCallGraphGtags,
  buildFunctionCallGraphGtags,
  buildWorkspaceCallGraphGtags,
  buildPathThroughCallGraphGtags,
  gtagsAvailable,
  collectGtagsCached,
  ensureGtagsDb,
} from './gtagsBackend';
import {
  fnv1a32,
  getWorkspaceRootForFile, hasCppSourceExtension,
} from './utils';

// Re-export for extension.ts backward compatibility
export type { Backend } from './types';
export type { GraphData } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 内部ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

function makeCacheKey(type: string, ...parts: string[]): string {
  return [type, ...parts].join('\x00');
}

// A3修正: 一時的な失敗(errors非空)やノード0件の結果を CACHE_TTL_MS(5分)固定しない。
// gtags のみが対象(LSP はそもそもキャッシュしない。理由は各関数内のコメント参照)。
function isCacheableResult(result: import('./types').GraphData): boolean {
  return result.errors.length === 0 && result.nodes.length > 0;
}

async function resolveBackend(
  backend: import('./types').Backend,
): Promise<'lsp' | 'gtags'> {
  if (backend === 'gtags') {
    // B12修正: 明示的に gtags を選んだ場合は事前にインストール状況を確認する。
    // 確認しないと、この後の処理が「No tags found」という誤解を招くエラーで
    // 失敗するだけで、実際の原因(gtags/globalコマンドが見つからない)が
    // ユーザーに伝わらなかった。GNU GLOBAL未導入は最初につまずきやすい点なので、
    // 導入方法つきのメッセージを最初に出す。
    if (!(await gtagsAvailable())) {
      throw new Error(
        'gtags backend was selected, but the `gtags`/`global` commands were not found on PATH.\n' +
        'Install GNU GLOBAL and try again:\n' +
        '  Debian/Ubuntu:  sudo apt install global\n' +
        '  macOS (Homebrew): brew install global\n' +
        '  Windows: see https://www.gnu.org/software/global/\n' +
        'Or switch to the LSP backend instead.');
    }
    return 'gtags';
  }
  if (backend === 'lsp') return 'lsp';
  return (await gtagsAvailable()) ? 'gtags' : 'lsp';
}

// B13修正: gtags は wsRoot 直下に GTAGS/GRTAGS/GPATH を生成するため、
// ワークスペースフォルダが開かれていない状態で使うと、意図しないディレクトリ
// (utils.ts の getWorkspaceRootForFile が「解析対象ファイルの親ディレクトリ」に
// フォールバックする)を汚してしまう。gtags 選択時はワークスペースが開かれていることを
// 必須にする(LSPバックエンドはワークスペース不要のまま利用できる)。
function assertWorkspaceOpenForGtags(resolved: 'lsp' | 'gtags'): void {
  if (resolved !== 'gtags') return;
  if (!vscode.workspace.workspaceFolders?.length) {
    throw new Error(
      'gtags backend requires an open workspace folder (it writes GTAGS/GRTAGS/GPATH there).\n' +
      'Open a folder as a workspace (File > Open Folder...) and try again, ' +
      'or switch to the LSP backend, which works without a workspace.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 公開 API
// ─────────────────────────────────────────────────────────────────────────────

export async function buildFileCallGraph(
  document: vscode.TextDocument,
  backend:  import('./types').Backend,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken,
): Promise<import('./types').GraphData> {
  const resolved = await resolveBackend(backend);
  assertWorkspaceOpenForGtags(resolved);
  const key      = makeCacheKey('file', document.uri.fsPath, resolved);
  // A3修正(案A): LSP結果はキャッシュしない。LSPはVSCodeの生きたドキュメント状態・
  // 言語サーバーのインデックス状態に依存する結果であり、5分固定すると
  // 「インデックス完了後に再実行してください」という案内(README)通りに再実行しても
  // 古い(不完全な)結果がキャッシュヒットしてしまい、意味がなかった。
  // 未保存の編集がある場合もキャッシュを使わない(保存時のファイルウォッチャーでしか
  // 無効化されないため、編集中は都度最新のバッファ内容で解析する)。
  const useCache = resolved === 'gtags' && !document.isDirty;
  const cached   = useCache ? cache.getGraph(key) : undefined;
  if (cached) return cached;
  // レースコンディション対策: 重い処理の開始前に世代を記録し、完了後に
  // 世代が変わっていたら(=処理中に invalidateFile/invalidateAll が発生していたら)
  // 古い内容での書き戻しをスキップする。
  const genAtStart = cache.getGeneration();
  const result   = resolved === 'gtags'
    ? await buildFileCallGraphGtags(document, progress, token)
    : await buildFileCallGraphLsp(document, progress, token);
  result.backend = resolved;
  if (useCache && isCacheableResult(result) && cache.getGeneration() === genAtStart) {
    cache.setGraph(key, result);
  }
  return result;
}

export async function buildFunctionCallGraph(
  document: vscode.TextDocument,
  position: vscode.Position,
  maxHops:  number | undefined,
  backend:  import('./types').Backend,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken,
): Promise<import('./types').GraphData> {
  const resolved = await resolveBackend(backend);
  assertWorkspaceOpenForGtags(resolved);
  const key      = makeCacheKey('func', document.uri.fsPath,
    `${position.line}:${position.character}:${maxHops}:${resolved}`);
  // A3修正: buildFileCallGraph と同じ理由(LSPは非キャッシュ、dirty時は不使用)。
  const useCache = resolved === 'gtags' && !document.isDirty;
  const cached   = useCache ? cache.getGraph(key) : undefined;
  if (cached) return cached;
  // レースコンディション対策(buildFileCallGraph 参照)。
  const genAtStart = cache.getGeneration();
  const result = resolved === 'gtags'
    ? await buildFunctionCallGraphGtags(document, position, maxHops, progress, token)
    : await buildFunctionCallGraphLsp(document, position, maxHops, progress, token);
  result.backend = resolved;
  if (useCache && isCacheableResult(result) && cache.getGeneration() === genAtStart) {
    cache.setGraph(key, result);
  }
  return result;
}

export async function buildWorkspaceCallGraph(
  uris:      vscode.Uri[],
  backend:   import('./types').Backend,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken,
): Promise<import('./types').GraphData> {
  const resolved   = await resolveBackend(backend);
  assertWorkspaceOpenForGtags(resolved);

  // ① uniqueUris の計算と空チェックをキャッシュキー生成より前に行う。
  // uris[0] が undefined のままキャッシュキーを作ると無効なキーでキャッシュが汚染される。
  const uniqueUris = Array.from(new Map(uris.map(u => [u.fsPath, u])).values())
    .filter(u => hasCppSourceExtension(u));
  if (!uniqueUris.length) throw new Error('No C/C++ source files found.');

  const sorted    = uniqueUris.map(u => u.fsPath).sort();
  const pathsHash = fnv1a32(sorted.join('\x00'));
  // ⑧ wsRootKey を sorted（重複排除済み）から導出することでキー順序依存を排除する。
  const wsRootKey = Array.from(new Set(
    sorted.map(p => getWorkspaceRootForFile(vscode.Uri.file(p)) ?? path.dirname(p))
  )).sort().join('\x01');
  const key       = makeCacheKey('workspace', wsRootKey, String(sorted.length), pathsHash, resolved);
  // A3修正: LSP結果はキャッシュしない(理由は buildFileCallGraph 参照)。
  // ワークスペース/フォルダ解析は単一の TextDocument を対象にしないため、
  // isDirty チェック(未保存編集の除外)は対象外とする。
  const useCache  = resolved === 'gtags';
  const cached    = useCache ? cache.getGraph(key) : undefined;
  if (cached) return cached;
  // レースコンディション対策(buildFileCallGraph 参照)。
  const genAtStart = cache.getGeneration();
  const result    = resolved === 'gtags'
    ? await buildWorkspaceCallGraphGtags(uniqueUris, progress, token)
    : await buildWorkspaceCallGraphLsp(uniqueUris, progress, token);
  result.backend = resolved;
  if (useCache && isCacheableResult(result) && cache.getGeneration() === genAtStart) {
    cache.setGraph(key, result);
  }
  return result;
}

export async function buildPathThroughCallGraph(
  document: vscode.TextDocument,
  position: vscode.Position,
  maxHops:  number | undefined,
  backend:  import('./types').Backend,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken,
): Promise<import('./types').GraphData> {
  const resolved = await resolveBackend(backend);
  assertWorkspaceOpenForGtags(resolved);
  const key      = makeCacheKey('path', document.uri.fsPath,
    `${position.line}:${position.character}:${maxHops}:${resolved}`);
  // A3修正: buildFileCallGraph と同じ理由(LSPは非キャッシュ、dirty時は不使用)。
  const useCache = resolved === 'gtags' && !document.isDirty;
  const cached   = useCache ? cache.getGraph(key) : undefined;
  if (cached) return cached;
  // レースコンディション対策(buildFileCallGraph 参照)。
  const genAtStart = cache.getGeneration();
  const result = resolved === 'gtags'
    ? await buildPathThroughCallGraphGtags(document, position, maxHops, progress, token)
    : await buildPathThroughCallGraphLsp(document, position, maxHops, progress, token);
  result.backend = resolved;
  if (useCache && isCacheableResult(result) && cache.getGeneration() === genAtStart) {
    cache.setGraph(key, result);
  }
  return result;
}

export async function warmupCache(
  document: vscode.TextDocument,
  backend:  import('./types').Backend,
): Promise<void> {
  const resolved = await resolveBackend(backend);
  if (resolved !== 'gtags') return;
  assertWorkspaceOpenForGtags(resolved);
  const wsRoot = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) return;
  // 重要: 必ず ensureGtagsDb (DB更新/初回生成) を先に行ってから collectGtagsCached でタグを読む。
  // 順序を逆にすると、DB更新前の内容がタグキャッシュ(TTL 5分)に焼き付いてしまい、
  // 直後に実ビルド側が ensureGtagsDb を呼んでも既にキャッシュヒットするため更新が反映されない。
  // (初回実行時は GTAGS 未生成のため collectGtagsCached が空タグを返し、
  //  ensureGtagsDb が直後に DB を新規生成しても「No tags found」で失敗する原因にもなる)
  await ensureGtagsDb(wsRoot).catch(() => {/* warmup は失敗してもよい */});
  await collectGtagsCached(wsRoot).catch(() => {/* warmup は失敗してもよい */});
}