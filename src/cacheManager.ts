/**
 * cacheManager.ts  ─  キャッシュ一元管理
 *
 * グラフ結果・gtags タグ・ファイル URI 等のキャッシュを 1 クラスに集約する。
 * invalidateFile / invalidateAll の 2 メソッドで全キャッシュの無効化を行う。
 *
 * キャッシュキーのセパレータは \x00 (NUL) に統一する。
 * NUL はファイルパス・C/C++ 関数名のいずれにも含まれないため安全。
 *
 * workspace キャッシュキー:
 *   workspace\x00<wsRoots_joined_\x01>\x00<count>\x00<hash>\x00<backend>
 *   全ワークスペースルートを \x01 区切りでソート結合することで
 *   マルチルート環境でも任意ルートのファイル変更を正しく検出できる。
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { GraphNode, GraphEdge, GraphData, GtagEntry, ScopeEntry, ScopeMapEntry } from './types';

// normalizeFsPath はここでローカルに定義する。
// utils.ts が cache (cacheManager) を import しているため、
// utils から import すると循環依存になる。
function normalizeFsPath(p: string): string {
  const n = path.normalize(p);
  // #2修正: utils.ts の normalizeFsPath と同じ理由(macOS/darwin も大文字小文字非依存)。
  // 循環import回避のためこのファイルにも同一内容を複製しているが、片方だけ更新される
  // リスクは既知(utils.ts側のコメント参照)。両方合わせて修正する。
  return process.platform !== 'linux' ? n.toLowerCase() : n;
}

export type { GraphNode, GraphEdge, GraphData, GtagEntry, ScopeEntry, ScopeMapEntry };

// ─────────────────────────────────────────────────────────────────────────────
// 型定義 (callGraphBuilder.ts から参照されるものを再エクスポート)
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// キャッシュエントリ型
// ─────────────────────────────────────────────────────────────────────────────

interface GraphCacheEntry   { data: GraphData;                     timestamp: number; }
interface TagsCacheEntry    {
  tags:           Map<string, GtagEntry[]>;
  scopeMap:       Map<string, ScopeMapEntry>;
  timestamp:      number;
}
interface FilesCacheEntry   { uris: vscode.Uri[];                  timestamp: number; }
interface LazyTagEntry      { entries: Map<string, GtagEntry[]>;   timestamp: number; }
interface LazyScopeEntry    { scopes:  Map<string, ScopeMapEntry>; timestamp: number; }
interface FolderFilesEntry  { uris: vscode.Uri[];                  ts:        number; }

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CACHE_ENTRIES         = 20;
const CACHE_TTL_MS              = 5 * 60_000;   // 5 分
const TAGS_CACHE_TTL_MS         = 5 * 60_000;   // 5 分 (GTAGS_UPDATE_TTL と同期)
const FILES_CACHE_TTL_MS        = 60_000;        // 60 秒
const LAZY_CACHE_TTL_MS         = 5 * 60_000;   // 5 分
const FOLDER_FILES_CACHE_TTL_MS = 60_000;        // 60 秒（extension.ts の FOLDER_FILES_CACHE_TTL と同値）
const REALPATH_CACHE_MAX        = 500;
const GTAGS_FALSE_TTL           = 30_000;        // 30 秒

// ─────────────────────────────────────────────────────────────────────────────
// パスユーティリティ (CacheManager 内部専用)
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// CacheManager
// ─────────────────────────────────────────────────────────────────────────────

export class CacheManager {

  // ── 世代カウンタ (レースコンディション対策) ───────────────────────────
  // invalidateFile / invalidateAll のたびに1つ進む。
  // 「非同期処理の開始時に読んだ世代」と「書き込み直前の世代」を呼び出し側
  // (callGraphBuilder.ts / collectGtagsCached / ensureGtagsDbInner) で比較し、
  // 処理中に無効化が発生していた場合は書き込みをスキップするために使う。
  // wsRoot/キー単位ではなくグローバルに1つだけ持つ設計のため、無関係な
  // ファイル保存でも書き込みがスキップされることがあるが、これは安全側
  // (キャッシュミスが増えるだけで、古いデータが焼き付くことはない)。
  private _generation = 0;

  getGeneration(): number { return this._generation; }

  // ── グラフ結果キャッシュ (FIFO 上限 20 件 + TTL 5 分) ──────────────────
  private readonly _graph = new Map<string, GraphCacheEntry>();

  getGraph(key: string): GraphData | undefined {
    const e = this._graph.get(key);
    if (!e) return undefined;
    if (Date.now() - e.timestamp >= CACHE_TTL_MS) { this._graph.delete(key); return undefined; }
    // 浅いコピーを返す: 呼び出し元(extension.ts の buildAndOutput() 等)は
    // 返り値の kind/subject を in-place で書き換えるため、キャッシュ実体をそのまま返すと
    // 内部状態が呼び出し元の都合で汚染されてしまう。nodes/edges/errors 配列自体は
    // 呼び出し元が変更しない前提のため、トップレベルのみの浅いコピーで十分。
    return { ...e.data };
  }

  setGraph(key: string, data: GraphData): void {
    // 既存キーは末尾に移動（FIFO 順を保つ）
    if (this._graph.has(key)) this._graph.delete(key);
    if (this._graph.size >= MAX_CACHE_ENTRIES) {
      const first = this._graph.keys().next().value;
      if (first !== undefined) this._graph.delete(first);
    }
    this._graph.set(key, { data, timestamp: Date.now() });
  }

  // ── gtags タグキャッシュ (wsRoot キー, TTL 5 分) ───────────────────────
  private readonly _tags = new Map<string, TagsCacheEntry>();

  getTags(wsRoot: string): TagsCacheEntry | undefined {
    const e = this._tags.get(wsRoot);
    if (!e) return undefined;
    if (Date.now() - e.timestamp >= TAGS_CACHE_TTL_MS) { this._tags.delete(wsRoot); return undefined; }
    return e;
  }

  setTags(wsRoot: string, entry: TagsCacheEntry): void {
    this._tags.set(wsRoot, entry);
  }

  // ── findFiles キャッシュ (固定キー, TTL 60 秒) ─────────────────────────
  private readonly _files = new Map<string, FilesCacheEntry>();

  getFiles(key: string): vscode.Uri[] | undefined {
    const e = this._files.get(key);
    if (!e) return undefined;
    if (Date.now() - e.timestamp >= FILES_CACHE_TTL_MS) { this._files.delete(key); return undefined; }
    return e.uris;
  }

  setFiles(key: string, uris: vscode.Uri[]): void {
    this._files.set(key, { uris, timestamp: Date.now() });
  }

  // ── lazyTag キャッシュ (wsRoot キー, TTL 5 分) ────────────────────────
  private readonly _lazyTags = new Map<string, LazyTagEntry>();

  getLazyTagEntry(wsRoot: string): LazyTagEntry | undefined {
    const e = this._lazyTags.get(wsRoot);
    if (!e) return undefined;
    if (Date.now() - e.timestamp >= LAZY_CACHE_TTL_MS) { this._lazyTags.delete(wsRoot); return undefined; }
    return e;
  }

  setLazyTagEntry(wsRoot: string, entry: LazyTagEntry): void {
    this._lazyTags.set(wsRoot, entry);
  }

  // ── lazyScope キャッシュ (wsRoot キー, TTL 5 分) ─────────────────────
  private readonly _lazyScopes = new Map<string, LazyScopeEntry>();

  getLazyScopeEntry(wsRoot: string): LazyScopeEntry | undefined {
    const e = this._lazyScopes.get(wsRoot);
    if (!e) return undefined;
    if (Date.now() - e.timestamp >= LAZY_CACHE_TTL_MS) { this._lazyScopes.delete(wsRoot); return undefined; }
    return e;
  }

  setLazyScopeEntry(wsRoot: string, entry: LazyScopeEntry): void {
    this._lazyScopes.set(wsRoot, entry);
  }

  // ── gtags DB 更新時刻 ────────────────────────────────────────────────
  private readonly _gtagsUpdateTs = new Map<string, number>();

  getGtagsUpdateTs(wsRoot: string): number {
    return this._gtagsUpdateTs.get(wsRoot) ?? 0;
  }

  setGtagsUpdateTs(wsRoot: string, ts: number): void {
    this._gtagsUpdateTs.set(wsRoot, ts);
  }

  // ── realpathCache (上限 500 件) ─────────────────────────────────────
  private readonly _realpath = new Map<string, string>();

  getRealpath(rawPath: string): string | undefined {
    return this._realpath.get(rawPath);
  }

  setRealpath(rawPath: string, resolved: string): void {
    if (this._realpath.size >= REALPATH_CACHE_MAX) this._realpath.clear();
    this._realpath.set(rawPath, resolved);
  }

  // ── gtags 存在チェック ──────────────────────────────────────────────
  // boolean と falseTs をペアで管理し、更新し忘れによる stale を防ぐ。
  private _gtagsAvailable: boolean | undefined = undefined;
  private _gtagsFalseTs:   number  | undefined = undefined;

  getGtagsAvailable(): { value: boolean; falseTs?: number } | undefined {
    if (this._gtagsAvailable === undefined) return undefined;
    return { value: this._gtagsAvailable, falseTs: this._gtagsFalseTs };
  }

  setGtagsAvailable(value: boolean): void {
    this._gtagsAvailable = value;
    this._gtagsFalseTs   = value ? undefined : Date.now();
  }

  get gtagsFalseTtl(): number { return GTAGS_FALSE_TTL; }

  // ── folderFilesCache (extension.ts から移動) ─────────────────────────
  private readonly _folderFiles = new Map<string, FolderFilesEntry>();

  // TTL チェックは内部で行い、呼び出し元には uris のみ返す。
  getFolderFiles(key: string): vscode.Uri[] | undefined {
    const e = this._folderFiles.get(key);
    if (!e) return undefined;
    if (Date.now() - e.ts >= FOLDER_FILES_CACHE_TTL_MS) { this._folderFiles.delete(key); return undefined; }
    return e.uris;
  }

  setFolderFiles(key: string, uris: vscode.Uri[]): void {
    this._folderFiles.set(key, { uris, ts: Date.now() });
  }

  // ─────────────────────────────────────────────────────────────────────
  // 無効化 API
  // ─────────────────────────────────────────────────────────────────────

  /**
   * ファイル内容・構造変更時の部分無効化。
   *
   * graphCache:
   *   - file / func / path キー: どのファイルが変更されても無条件で削除する。
   *     A3修正: 以前は「セグメント[1]が変更ファイルと完全一致する場合のみ削除」だったが、
   *     コールグラフは呼び出し先・呼び出し元として他ファイルにも依存するため、
   *     依存先ファイルの編集がキャッシュに反映されない問題があった。
   *     invalidateFile はファイルウォッチャーから C/C++ ファイルの変更時のみ呼ばれるため、
   *     ここでは常に file/func/path 全体を消去してよい
   *     (gtags のみキャッシュ対象であり高速なため、体感への影響は小さい)。
   *   - workspace キー: セグメント[1] が '\x01' 区切りの全 wsRoot リスト。
   *     いずれかの wsRoot 配下なら削除（マルチルート対応）
   *
   * tagsCache / lazyTagCache / lazyScopeCache / gtagsUpdateTs:
   *   変更ファイルが属する wsRoot のエントリのみ削除(gtagsUpdateTsも同時に削除し、
   *   次回は必ず global -u を実行させる。TTL 内のスキップによる stale データ防止)
   *   どの wsRoot にも属さない場合は全クリア（安全側）
   *
   * filesCache / folderFilesCache:
   *   構造変更時（onDidCreate / onDidDelete）のみ呼び出し元が全クリアする。
   *   内容変更時（onDidChange）は触らない。
   *
   * realpathCache:
   *   シンボリックリンクの向き先変更に対応するため常に全クリア。
   */
  invalidateFile(fsPath: string): void {
    // レースコンディション対策: 世代を進める。
    // このメソッド呼び出し以降に「処理開始時の世代」と比較する側は、
    // 呼び出し前から実行中だった非同期処理の結果を書き込まなくなる。
    this._generation++;

    const norm = normalizeFsPath(fsPath);

    // ── graphCache ──────────────────────────────────────────────────────
    for (const key of this._graph.keys()) {
      const segments = key.split('\x00');
      const type     = segments[0];

      if (type === 'workspace') {
        // segments[1] = '\x01' 区切りの全 wsRoot
        const roots = segments[1]?.split('\x01') ?? [];
        const hit   = roots.some(r => {
          const rn = normalizeFsPath(r);
          return norm === rn || norm.startsWith(rn + '/') || norm.startsWith(rn + path.sep);
        });
        if (hit) this._graph.delete(key);
      } else {
        // file / func / path: 呼び出し先・呼び出し元として他ファイルにも依存しうるため、
        // 変更ファイルとの一致を問わず無条件で削除する。
        this._graph.delete(key);
      }
    }

    // ── tagsCache / lazyTagCache / lazyScopeCache / gtagsUpdateTs ───────
    // _gtagsUpdateTs もここで一緒に無効化しないと、TTL(5分)内の再解析時に
    // ensureGtagsDb が「まだ新しい」と誤判定して global -u をスキップし、
    // 編集前の GTAGS データのままグラフが返ってしまう。
    const allWsRoots = new Set([
      ...this._tags.keys(),
      ...this._lazyTags.keys(),
      ...this._lazyScopes.keys(),
      ...this._gtagsUpdateTs.keys(),
    ]);

    const affected = [...allWsRoots].filter(wsRoot => {
      const rn = normalizeFsPath(wsRoot);
      return norm === rn || norm.startsWith(rn + '/') || norm.startsWith(rn + path.sep);
    });

    if (affected.length === 0) {
      // どの wsRoot にも属さない変更は全削除（安全側）
      this._tags.clear();
      this._lazyTags.clear();
      this._lazyScopes.clear();
      this._gtagsUpdateTs.clear();
    } else {
      for (const wsRoot of affected) {
        this._tags.delete(wsRoot);
        this._lazyTags.delete(wsRoot);
        this._lazyScopes.delete(wsRoot);
        this._gtagsUpdateTs.delete(wsRoot);
      }
    }
    // _files（ファイル URI リスト）はファイル内容変更では無効化不要。
    // 構造変更（onDidCreate / onDidDelete）時は invalidateFileList() が呼ばれる。

    // ── realpathCache: シンボリックリンク変更に対応するため常に全クリア ──
    this._realpath.clear();
  }

  /**
   * 全キャッシュを削除する。
   * 拡張機能の deactivate 時・テスト間のリセットに使用する。
   */
  invalidateAll(): void {
    // レースコンディション対策: invalidateFile と同様に世代を進める。
    // これがないと、invalidateAll でクリアした直後に、それより前から
    // 実行中だった処理が古い結果を書き戻してクリアを巻き戻してしまう。
    this._generation++;

    this._graph.clear();
    this._tags.clear();
    this._files.clear();
    this._lazyTags.clear();
    this._lazyScopes.clear();
    this._gtagsUpdateTs.clear();
    this._realpath.clear();
    this._folderFiles.clear();
    this._gtagsAvailable = undefined;
    this._gtagsFalseTs   = undefined;
  }

  /**
   * ファイル構造変更時（onDidCreate / onDidDelete）の
   * filesCache / folderFilesCache クリア専用 API。
   */
  invalidateFileList(): void {
    // findFilesCached() の世代チェックがこのメソッド単体の呼び出しにも
    // 反応できるよう、こちらでも世代を進めておく(現状の呼び出し元では
    // 常に invalidateFile と同時に呼ばれるため実害はないが、将来単体で
    // 呼ばれるようになった場合の取りこぼしを防ぐ)。
    this._generation++;
    this._files.clear();
    this._folderFiles.clear();
  }
}

/** モジュールレベルのシングルトン */
export const cache = new CacheManager();