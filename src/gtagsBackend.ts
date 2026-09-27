/**
 * gtagsBackend.ts  ─  gtags バックエンド実装
 *
 * GNU Global を使ったコールグラフ構築。
 * BFS エンジン (gtagsBfsDown, gtagsBfsUp 各バリアント) も含む。
 */

import * as vscode    from 'vscode';
import * as path      from 'path';
import * as fs        from 'fs';
import * as os        from 'os';
import { execFile }   from 'child_process';
import { promisify }  from 'util';
import { cache }      from './cacheManager';
import {
  GraphNode, GraphData,
  GtagEntry, ScopeEntry, ScopeMapEntry,
  MAX_SOURCE_LINES,
} from './types';
import {
  normalizeFsPath, splitEdges,
  getWorkspaceRoots, getWorkspaceRootForFile,
  findScopeMapEntry, findScopeAtLine, touchScopeMap,
  isLikelyFuncDef, makeGtagsNodeId, parseGtagsNodeId, escapeRegexForGlobal,
  Pct, checkCancellation, CC_SOURCE_EXTENSIONS, EXCLUDE_DIRS,
} from './utils';
export type { GraphData };

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

const CC_ALL_GLOB       = '**/*.{c,cpp,cc,cxx,cu,cuh,h,hpp,hxx}';
// N-fix: 以前は EXCLUDE_GLOB をここに独立したリテラルとして持っていたが、
// utils.ts の EXCLUDE_DIRS(CMake/vendor 系ディレクトリ等を含む)と内容が乖離していた
// (utils.ts のコメントが警告していた「別々に定義すると片方だけ更新される」状態が
//  実際に発生していた: __pycache__/.venv/.mypy_cache は EXCLUDE_GLOB のみ、
//  CMakeFiles/_build/_deps/cmake-build-*/.ccls-cache/vendor/.deps は EXCLUDE_DIRS のみ)。
// EXCLUDE_DIRS から動的生成することで一元化し、以後の乖離を構造的に防ぐ。
// (__pycache__ 等 Python 系ディレクトリも合わせて EXCLUDE_DIRS 側に統合する)
const EXCLUDE_GLOB      = `{${[...EXCLUDE_DIRS].map(d => `**/${d}/**`).join(',')}}`;
const GTAGS_UPDATE_TTL_DEFAULT = 5 * 60_000;  // ms (callatlas.gtagsUpdateInterval 未設定時のフォールバック)
const GLOBAL_RX_PARALLEL = Math.max(4, Math.min(os.cpus().length * 2, 32));
const WORKSPACE_FILES_KEY = '__workspace__';

/** promisify した execFile。全 global / gtags 呼び出しで共用する。 */
const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// gtags インストール確認
// ─────────────────────────────────────────────────────────────────────────────

/**
 * gtags コマンドが使用可能かを確認する。
 * true は永続キャッシュ（インストール済み gtags が突然消えることはない）。
 * false は 30 秒 TTL で再チェック可能にする。
 */
export async function gtagsAvailable(): Promise<boolean> {
  const cached = cache.getGtagsAvailable();
  if (cached?.value === true) return true;
  if (cached?.value === false && cached.falseTs !== undefined) {
    if (Date.now() - cached.falseTs < cache.gtagsFalseTtl) return false;
  }
  try {
    await execFileAsync('gtags', ['--version'], { timeout: 5_000 });
    cache.setGtagsAvailable(true);
  } catch {
    cache.setGtagsAvailable(false);
  }
  return cache.getGtagsAvailable()!.value;
}




export async function findFilesCached(): Promise<vscode.Uri[]> {
  const cached = cache.getFiles(WORKSPACE_FILES_KEY);
  if (cached) return cached;
  // レースコンディション対策: findFiles() 実行中に invalidateFileList()
  // (ファイル作成/削除時) が発生していた場合、その完了後の結果を無条件で
  // 書き戻すと無効化が巻き戻ってしまう。他の3箇所(グラフ結果・gtagsタグ・
  // GTAGS更新時刻)と同じ生成カウンタ方式で塞ぐ。
  const genAtStart = cache.getGeneration();
  const uris = await vscode.workspace.findFiles(CC_ALL_GLOB, EXCLUDE_GLOB);
  if (cache.getGeneration() === genAtStart) cache.setFiles(WORKSPACE_FILES_KEY, uris);
  return uris;
}

/**
 * collectGtags の結果を TAGS_CACHE_TTL_MS キャッシュする。
 * キャッシュヒット時は lineCache を空で返す（オンデマンド読み込み用）。
 * タグマップ自体は読み取り専用で参照するため共有しても安全。
 */
export async function collectGtagsCached(wsRoot: string): Promise<{
  tags:           Map<string, GtagEntry[]>;
  lineCache:      Map<string, string[]>;
  scopeMap:       Map<string, ScopeMapEntry>;
  /** 今回の呼び出しで新たに解決できなかった参照の件数。キャッシュヒット時は常に0
   *  (新規計算していないため)。呼び出し元は0より大きい場合のみ警告する。 */
  droppedRefCount: number;
}> {
  const cached = cache.getTags(wsRoot);
  if (cached) {
    return {
      tags:            cached.tags,
      lineCache:       new Map(),
      scopeMap:        cached.scopeMap,
      droppedRefCount: 0,
    };
  }
  // N4修正: ファイル列挙(findFilesCached)は collectGtags のフォールバック時にしか
  // 使わないため、即時実行せず関数として渡す(通常経路では一度も評価されない)。
  const getFiles = async (): Promise<string[]> => {
    const allUris    = await findFilesCached();
    // findFilesCached() は全ワークスペースのファイルを返すため、
    // cwd: wsRoot で実行する collectGtags のフォールバックパスに渡す前に
    // wsRoot 配下のファイルのみに絞り込む。
    const wsRootNorm = normalizeFsPath(wsRoot);
    return allUris.filter(u => {
      const n = normalizeFsPath(u.fsPath);
      return n === wsRootNorm || n.startsWith(wsRootNorm + '/') || n.startsWith(wsRootNorm + path.sep);
    }).map(u => u.fsPath);
  };
  // レースコンディション対策: collectGtags() 実行中に invalidateFile/invalidateAll
  // が発生していた場合、その完了後の結果を無条件でキャッシュに書き戻すと、
  // 無効化が黙って巻き戻ってしまう(古いタグが最大 TAGS_CACHE_TTL_MS 生き残る)。
  // 開始時点の世代を記録し、書き込み直前に変化していないか確認する。
  const genAtStart = cache.getGeneration();
  const result   = await collectGtags(getFiles, wsRoot);
  const scopeMap = buildGtagsScopeMap(result.tags);
  // 防御的修正: タグが1件も取れなかった場合はキャッシュしない。
  // (DB未生成直後や一時的な取得失敗の空結果を TTL 5分間キャッシュし続けると、
  //  その間ずっと「No tags found」等の誤ったエラーが再現し続けてしまうため)
  if (result.tags.size > 0 && cache.getGeneration() === genAtStart) {
    cache.setTags(wsRoot, {
      tags:           result.tags,
      scopeMap,
      timestamp:      Date.now(),
    });
  }
  return { ...result, scopeMap };
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  内部ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Python 版 is_function_def と同等のヒューリスティック。
 * 純粋仮想・deleted・defaulted 関数宣言を除外する。
 * = 0, = delete, = default で終わる行は定義ではなく宣言のため false を返す。
 */

/**
 * spawn ENOTDIR の原因と対処を説明するメッセージを生成する。
 * WSL + Windows ハイブリッド環境で PATH に Windows 形式パスが混入すると発生する。
 */
function spawnErrorMessage(cmd: string, err: unknown): string {
  const msg = String(err);
  if (msg.includes('ENOTDIR')) {
    return (
      `[gtags] Failed to launch ${cmd} (ENOTDIR).\n` +
      'Your PATH may contain Windows-style paths (e.g. C:\\Windows\\System32) in WSL.\n' +
      `Fix: add "export PATH=$(echo $PATH | tr ':' '\\n' | grep -v '^/mnt/' | tr '\\n' ':')" to ~/.bashrc`
    );
  }
  if (msg.includes('ENOENT')) {
    return `[gtags] ${cmd} not found. Check that the gtags/global install directory is in your PATH.`;
  }
  return `[gtags] Failed to launch ${cmd}: ${msg}`;
}

/**
 * B12修正: 「No tags found」で投げる前に、ensureGtagsDb 等が errs に積んだ
 * 警告(gtags未導入・DB更新失敗の詳細等)をエラーメッセージに含める。
 * 以前は errs に実際の原因が入っていても throw のメッセージには反映されず、
 * ユーザーには "No tags found" としか見えていなかった。
 */
function noTagsFoundError(baseMsg: string, errs: string[]): Error {
  const detail = errs.length > 0 ? `\n${errs.slice(0, 3).join('\n')}` : '';
  return new Error(`${baseMsg}${detail}`);
}

/**
 * callatlas.gtagsUpdateInterval 設定を読み取り、
 * ensureGtagsDb が使う「TTL(ms)」または 'off' に変換する。
 *   'always' → 0 (常に global -u を実行)
 *   '5'/'30'/'60' → 分 → ms
 *   'off' → 自動更新しない
 *   不正値/未設定 → デフォルト(5分)にフォールバック
 */
function getGtagsUpdateTtl(): number | 'off' {
  const setting = vscode.workspace.getConfiguration('callatlas')
    .get<string>('gtagsUpdateInterval', '5');
  if (setting === 'off')    return 'off';
  if (setting === 'always') return 0;
  const minutes = Number(setting);
  return (Number.isFinite(minutes) && minutes > 0) ? minutes * 60_000 : GTAGS_UPDATE_TTL_DEFAULT;
}

/**
 * B16修正: 同一 wsRoot に対する ensureGtagsDb の同時実行を防ぐための
 * 実行中 Promise の共有マップ。ワークスペース解析とファイル解析をほぼ同時に
 * 実行した場合等、`gtags`/`global -u` が同一ディレクトリで二重起動されると
 * 両プロセスが同時に DB ファイルへ書き込み、GTAGS が壊れる可能性がある。
 * 2回目以降の呼び出しは新規プロセスを起動せず、1回目の完了を待つだけにする。
 */
const _ensureGtagsDbInFlight = new Map<string, Promise<string | undefined>>();

/**
 * GTAGS が存在しなければ gtags を実行して DB 構築。
 * 存在する場合は global -u でインクリメンタル更新する。
 * callatlas.gtagsUpdateInterval 設定(デフォルト5分)以内の再実行は
 * global -u をスキップして連続実行のオーバーヘッドを抑制する。'off' 指定時は
 * 初回構築のみ行い、以降は自動更新しない(ユーザーが手動で gtags を実行する前提)。
 * 戻り値: 警告メッセージ（問題なければ undefined）。呼び出し元が errs に追加する。
 */
export async function ensureGtagsDb(wsRoot: string): Promise<string | undefined> {
  const inFlight = _ensureGtagsDbInFlight.get(wsRoot);
  if (inFlight) return inFlight;
  const p = ensureGtagsDbInner(wsRoot).finally(() => {
    _ensureGtagsDbInFlight.delete(wsRoot);
  });
  _ensureGtagsDbInFlight.set(wsRoot, p);
  return p;
}

async function ensureGtagsDbInner(wsRoot: string): Promise<string | undefined> {
  // wsRoot が空文字列や相対パスの場合、意図しないディレクトリで
  // gtags が実行されるリスクがあるため早期リターンする。
  if (!wsRoot || !path.isAbsolute(wsRoot)) {
    return '[gtags] Internal error: wsRoot is not an absolute path.';
  }
  const now = Date.now();
  if (fs.existsSync(path.join(wsRoot, 'GTAGS'))) {
    const ttl = getGtagsUpdateTtl();
    if (ttl === 'off') return undefined; // 自動更新オフ: 既存DBをそのまま使う
    const last = cache.getGtagsUpdateTs(wsRoot);
    if (now - last < ttl) return undefined; // TTL 内はスキップ
    // レースコンディション対策: global -u / gtags 実行中に invalidateFile が
    // _gtagsUpdateTs.delete(wsRoot) を実行していた場合、その完了後に
    // 無条件で setGtagsUpdateTs(wsRoot, now) すると「更新前の時刻」で
    // タイムスタンプが復活し、次回以降 global -u が誤ってスキップされ続ける
    // (GTAGS 自体が編集内容を反映しないまま使われ続ける、最も深刻なパターン)。
    // 実行開始時点の世代を記録し、書き込み直前に変化していないか確認する。
    const genAtStart = cache.getGeneration();
    try {
      await execFileAsync('global', ['-u'], { cwd: wsRoot, timeout: 120_000 });
      if (cache.getGeneration() === genAtStart) cache.setGtagsUpdateTs(wsRoot, now);
    } catch (updateErr) {
      try {
        await runGtagsWithDotfilesCompat(wsRoot);
        if (cache.getGeneration() === genAtStart) cache.setGtagsUpdateTs(wsRoot, now);
      } catch (rebuildErr) {
        return spawnErrorMessage('global -u / gtags rebuild', rebuildErr);
      }
    }
  } else {
    // 初回構築の場合も同様に世代を記録・比較する。
    const genAtStart = cache.getGeneration();
    try {
      await runGtagsWithDotfilesCompat(wsRoot);
    } catch (initErr) {
      return spawnErrorMessage('gtags', initErr);
    }
    if (cache.getGeneration() === genAtStart) cache.setGtagsUpdateTs(wsRoot, now);
  }
  return undefined;
}

/**
 * GNU GLOBAL のバージョン互換を考慮した gtags 実行ヘルパー。
 * --accept-dotfiles は 6.5 以降のオプション。旧バージョンでは
 * "unrecognized option" で終了するため、失敗した場合はオプションなしで再試行する。
 */
async function runGtagsWithDotfilesCompat(wsRoot: string): Promise<void> {
  try {
    await execFileAsync('gtags', ['--accept-dotfiles'], { cwd: wsRoot, timeout: 120_000 });
  } catch (err) {
    const msg = String(err);
    // --accept-dotfiles 未サポートの場合のみフォールバック
    if (/unrecognized option|invalid option|unknown option/i.test(msg)) {
      await execFileAsync('gtags', [], { cwd: wsRoot, timeout: 120_000 });
    } else {
      throw err;
    }
  }
}

/**
 * GTAGS 出力パスの path traversal を防ぐ。
 * GTAGS が改ざんされていた場合に ../../etc/passwd などの
 * ワークスペース外ファイルへのアクセスを防止する。
 * wsRoot 外のパスは null を返す。
 */
function sanitizeToWsRoot(rawPath: string, wsRoot: string): string | null {
  const fp          = path.isAbsolute(rawPath) ? rawPath : path.resolve(wsRoot, rawPath);
  // 一次チェック: normalizeFsPath で大文字小文字を統一してプレフィックス検証
  const fpNorm      = normalizeFsPath(fp);
  const wsRootNorm  = normalizeFsPath(wsRoot);
  const wsRootSlash = wsRootNorm.endsWith(path.sep) ? wsRootNorm : wsRootNorm + path.sep;
  if (!(fpNorm.startsWith(wsRootSlash) || fpNorm === wsRootNorm)) return null;
  // 二次チェック: シンボリックリンクを解決して実パスで再検証。
  // ワークスペース内のシンボリックリンク → ワークスペース外ファイル のトラバーサルを防ぐ。
  try {
    const realFp = cache.getRealpath(fp) ?? (() => {
      const r = fs.realpathSync(fp); cache.setRealpath(fp, r); return r;
    })();
    const realRoot = cache.getRealpath(wsRoot) ?? (() => {
      const r = fs.realpathSync(wsRoot); cache.setRealpath(wsRoot, r); return r;
    })();
    const realFpNorm   = normalizeFsPath(realFp);
    const realRootNorm = normalizeFsPath(realRoot);
    const realSlash    = realRootNorm.endsWith(path.sep) ? realRootNorm : realRootNorm + path.sep;
    if (!(realFpNorm.startsWith(realSlash) || realFpNorm === realRootNorm)) return null;
  } catch {
    return null;
  }
  return fp;
}

/**
 * マルチルートワークスペース対応の sanitize ヘルパー。
 * wsRoots の中の任意のルートに含まれるパスを受け入れる。
 * wsRoots が空の場合は null を返す。
 */
function sanitizeToAnyWsRoot(rawPath: string, wsRoots: string[]): string | null {
  for (const root of wsRoots) {
    const result = sanitizeToWsRoot(rawPath, root);
    if (result !== null) return result;
  }
  return null;
}

/**
 * `global -f <file>` を実行してそのファイルで定義されているタグを取得。
 * per-file フォールバックパスおよび buildScopeForFileCached で使用する。
 */
async function runGlobalF(
  absFile: string, wsRoot: string
): Promise<Array<{ name: string; line: number; file: string }>> {
  try {
    const relFile = path.relative(wsRoot, absFile);
    const { stdout } = await execFileAsync('global', ['-f', relFile], {
      cwd: wsRoot, maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.split('\n').flatMap(line => {
      const parts = line.split(/\s+/);
      if (parts.length < 3) return [];
      const name   = parts[0];
      const lineno = parseInt(parts[1], 10);
      if (!name || isNaN(lineno)) return [];
      const fp = sanitizeToWsRoot(parts[2], wsRoot);
      if (!fp) return [];
      return [{ name, line: lineno, file: fp }];
    });
  } catch {
    return [];
  }
}

/** ファイルを行配列で読み込み、キャッシュする（同期版・キャッシュヒット専用） */
function readFileLinesCached(filePath: string, cache: Map<string, string[]>): string[] {
  if (cache.has(filePath)) return cache.get(filePath)!;
  // 呼び出し元は事前に prefetchFileLines / getFileLinesAsync でキャッシュを温めること。
  // フォールバックの同期読み込みは大規模プロジェクトでホストをブロックするため行わない。
  return [];
}

/**
 * 非同期ファイル行読み込み。
 * キャッシュヒット時は即座に返し、ミス時のみ fs.promises.readFile で非同期読み込みする。
 */
async function getFileLinesAsync(filePath: string, cache: Map<string, string[]>): Promise<string[]> {
  if (cache.has(filePath)) return cache.get(filePath)!;
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines   = content.split('\n');
    cache.set(filePath, lines);
    return lines;
  } catch {
    // エラー時はキャッシュせず空配列を返す（キャッシュすると TTL 内ずっとそのファイルが消える）
    return [];
  }
}

/**
 * 必要なファイルを事前に並列プリフェッチしてキャッシュを温める。
 */
async function prefetchFileLines(files: readonly string[], cache: Map<string, string[]>): Promise<void> {
  const needed = [...new Set(files)].filter(f => !cache.has(f));
  if (needed.length === 0) return;
  await Promise.all(needed.map(f => getFileLinesAsync(f, cache)));
}

/**
 * `global -x -e '.'` を1回実行してすべての定義タグを一括取得。
 * GNU Global 5.0 以降が必要（-e で POSIX ERE を有効化）。
 * ソース行は global 出力に含まれるためファイルを読まない。
 * 出力形式: name<ws>line<ws>file<ws>source_line
 *
 * maxBuffer は 256MB を設定。これを超えるプロジェクトには
 * spawn + readline によるストリーム処理への移行を推奨する。
 */
async function runGlobalXAll(
  wsRoot: string
): Promise<{ entries: Array<{ name: string; line: number; file: string; sourceLine: string }>; droppedCount: number }> {
  const { stdout } = await execFileAsync('global', ['-x', '-e', '.'], {
    cwd: wsRoot, maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
  });
  let droppedCount = 0;
  const entries = stdout.split('\n').flatMap(raw => {
    const trimmed = raw.trimEnd();
    if (!trimmed) return [];
    const m = trimmed.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) return [];
    const [, name, lineStr, fileStr, sourceLine] = m;
    const line = parseInt(lineStr, 10);
    if (isNaN(line)) return [];
    // name にセパレータが混入するとパースが破壊されるためスキップする
    if (!name || name.includes('\x00') || name.includes('|||')) return [];
    const file = sanitizeToWsRoot(fileStr, wsRoot);
    if (!file) {
      // N5修正: global -x の出力を空白で分割しているため、フォルダ名に空白が
      // 含まれるパス(例: "src/My Module/mod.c")は "src/My" のように途中で
      // 切れてしまい、実在しないパスとして静かに捨てられていた
      // (これまでは警告なし)。件数だけでも数えて呼び出し元で警告できるようにする。
      droppedCount++;
      return [];
    }
    return [{ name, line, file, sourceLine }];
  });
  return { entries, droppedCount };
}

/**
 * タグを収集して Map<name, GtagEntry[]> を返す。
 * global -x -e '.' による一括取得を優先し、失敗した場合は
 * per-file global -f にフォールバックする（GNU Global < 5.0 対応）。
 * ソース行は global 出力またはオンデマンド読み込みで取得するため
 * lineCache は空で返す。全候補を GtagEntry[] として保持し、
 * resolveCallee() が callerFile 優先で解決する。
 */
async function collectGtags(
  getFiles: () => Promise<string[]>,
  wsRoot: string
): Promise<{ tags: Map<string, GtagEntry[]>; lineCache: Map<string, string[]>; droppedRefCount: number }> {
  const lineCache = new Map<string, string[]>(); // オンデマンド読み込み用（空で返す）

  // 高速パス: global -x -e '.' 一括取得
  type RawEntry = { name: string; line: number; file: string; sourceLine: string };
  let rawEntries: RawEntry[];
  let droppedRefCount = 0;
  try {
    const r = await runGlobalXAll(wsRoot);
    rawEntries      = r.entries;
    droppedRefCount = r.droppedCount;
  } catch {
    // フォールバック: per-file global -f
    // N4修正: ファイル一覧(ワークスペース全体の列挙)は、この失敗時にしか使わないため、
    // 呼び出し元から関数として渡してもらい、実際に必要になった時だけ評価する。
    // 通常(高速パスが成功する)は一度も呼ばれず、大規模プロジェクトでの
    // 無駄な列挙が無くなる。
    const files = await getFiles();
    const perFileResults: Array<{ name: string; line: number; file: string }> = [];
    const perFileConcurrent = Math.min(16, files.length);
    for (let i = 0; i < files.length; i += perFileConcurrent) {
      const results = await Promise.all(
        files.slice(i, i + perFileConcurrent).map(f => runGlobalF(f, wsRoot))
      );
      for (const entries of results) perFileResults.push(...entries);
    }
    rawEntries = perFileResults.map(e => ({ ...e, sourceLine: '' }));
  }

  const rawMap = new Map<string, RawEntry[]>();
  // 10000 件ごとに setImmediate で制御を返し VS Code の応答性を維持する。
  for (let i = 0; i < rawEntries.length; i++) {
    if (i > 0 && i % 10_000 === 0) await new Promise<void>(r => setImmediate(r));
    const e = rawEntries[i];
    if (!rawMap.has(e.name)) rawMap.set(e.name, []);
    rawMap.get(e.name)!.push(e);
  }

  const tags = new Map<string, GtagEntry[]>();

  // sourceLine が空のエントリ（per-file フォールバック時）のファイルを事前に並列プリフェッチ。
  // 後続の readFileLinesCached がキャッシュヒットするよう先に読み込んでおく。
  {
    const filesNeedingRead: string[] = [];
    for (const [, candidates] of rawMap) {
      for (const cand of candidates) {
        if (!cand.sourceLine) filesNeedingRead.push(cand.file);
      }
    }
    await prefetchFileLines(filesNeedingRead, lineCache);
  }

  for (const [name, candidates] of rawMap) {
    const entries: GtagEntry[] = candidates.map(cand => {
      // sourceLine が空 (per-file fallback) の場合のみファイルを読む
      let sourceLine = cand.sourceLine;
      if (!sourceLine) {
        const ll = readFileLinesCached(cand.file, lineCache);
        sourceLine = ll[cand.line - 1]?.trimEnd() ?? '';
      }
      return { name, file: cand.file, line: cand.line, sourceLine, isFunc: isLikelyFuncDef(sourceLine) };
    });
    tags.set(name, entries);
  }
  return { tags, lineCache, droppedRefCount };
}

/**
 * タグマップからスコープマップを構築する。
 * isFunc=true のエントリのみでスコープを区切る。
 * byName で O(1) ルックアップ、同名関数が複数ファイルにある場合も
 * 各 (file, name) ペアが独立したスコープとして登録される。
 */

function buildGtagsScopeMap(tags: Map<string, GtagEntry[]>): Map<string, ScopeMapEntry> {
  const fileMap = new Map<string, { name: string; line: number }[]>();
  for (const [name, entries] of tags) {
    for (const info of entries) {
      if (!info.isFunc) continue;
      if (!fileMap.has(info.file)) fileMap.set(info.file, []);
      fileMap.get(info.file)!.push({ name, line: info.line });
    }
  }
  const scopeMap = new Map<string, ScopeMapEntry>();
  for (const [fp, entries] of fileMap) {
    entries.sort((a, b) => a.line - b.line);
    const list: ScopeEntry[] = entries.map((e, i) => ({
      name:  e.name,
      start: e.line,
      end:   i + 1 < entries.length ? entries[i + 1].line - 1 : Number.MAX_SAFE_INTEGER,
    }));
    // 同一ファイル内に同名関数が複数ある場合（#ifdef 分岐等）は先勝ち（行番号が小さい定義を優先）
    // 呼び出し元では可能な限り findScopeAtLine（行番号優先）を使うこと。
    const byName = new Map<string, ScopeEntry>();
    for (const s of list) {
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
    scopeMap.set(fp, { list, byName });
    touchScopeMap(scopeMap);
  }
  return scopeMap;
}

/**
 * ソース行の [start, end] 範囲を走査し、
 * knownTags に含まれる呼び出し先（自己再帰除外）を返す。
 * 文字列リテラル内の誤検出を除去し、C++11 RAW文字列リテラルにも対応する。
 */
/**
 * N2修正: 「型 名前(...)」の形をした行(前方宣言・クラス内メンバ宣言等)を
 * 呼び出しとして数えないための判定。呼び出し箇所の識別子直前の文字列(prefix)を見て、
 * 「型名らしきトークン列で終わっている」場合は宣言とみなす。
 * ヒューリスティックであり、`a * foo(3);` のように「型のように見える式」は
 * 宣言と誤判定しうる(既知の限界。実コードではほぼ出ない形)。
 */
const NON_TYPE_WORDS = new Set([
  'return', 'else', 'case', 'goto', 'do', 'sizeof', 'throw', 'new', 'delete', 'typeof', 'alignof',
  'co_return', 'co_yield', 'co_await', 'and', 'or', 'not', 'xor', 'defined',
]);

function isDeclarationPrefix(prefix: string): boolean {
  if (!prefix.trim()) return false;                          // 文頭の呼び出し foo(...)
  // 直前の修飾(Ns:: / Class::)を外す。修飾だけが前にある場合は「修飾付きの呼び出し」
  const q = prefix.replace(/(?:[A-Za-z_]\w*\s*::\s*)+$/, '');
  if (!q.trim() || !/[\s*&]$/.test(q)) return false;
  // B3修正: "if (a &&\n    b && foo(1))" のような複数行にまたがる論理AND条件の
  // 継続行では、prefix が "b && " のようになり、"T&& foo(...)"(右辺値参照を返す
  // 関数宣言)と区別がつかず宣言と誤判定してしまう(&&もこの後の判定を素通りしてしまう)。
  // 論理ANDの継続行の方が実務上圧倒的に多く現れ、誤判定時の実害も「宣言をcallとして
  // 拾ってしまう」程度で済む(本物のcallを取りこぼす方が実害が大きい)ため、
  // && を含む場合は宣言ではないと判定する。
  if (/&&/.test(q)) return false;
  const t = q.replace(/<[^<>()=;]*>/g, '');                  // テンプレート引数を除去
  if (/(?<!:):(?!:)/.test(t)) return false;                  // ラベル(retry: / default: / case N:)は宣言ではない
  if (!/^[A-Za-z_][\w:\s*&~]*$/.test(t.trim())) return false; // 演算子・括弧・代入等 → 式の一部
  const tokens = t.match(/[A-Za-z_]\w*/g) ?? [];
  return tokens.length > 0 && !tokens.some(w => NON_TYPE_WORDS.has(w));
}

function isDeclarationRef(srcLine: string, name: string): boolean {
  const m = new RegExp('\\b' + escapeRegexForGlobal(name) + '\\s*\\(').exec(srcLine);
  return m ? isDeclarationPrefix(srcLine.slice(0, m.index)) : false;
}

// バグ修正: C++14 の桁区切り文字(digit separator, 例: 1'024, 0x1234'5678)を
// 文字リテラルの開始と誤認しないための判定。
// 以前は extractCallsFromLines() 内で '\'' を見つけると常に「次の unescaped '\'' まで
// 読み飛ばす」文字リテラル処理に入っていたため、桁区切りが奇数個(1個)しかない数値
// (例: 65'536)を含む行では閉じクォートが見つからず行末までを丸ごと読み飛ばしてしまい、
// 同じ行より後方にある関数呼び出しが検出できなくなっていた
// (例: `size_t n = 65'536; foo(n);` の foo(n) が消える)。
// '\'' の直前・直後が両方とも16進数字([0-9a-fA-F])であれば桁区切りとみなして
// スキップする。文字リテラルの開始('0' 等)は通常、直前に演算子・空白・括弧等が来て
// 数字が直接前置されることはない(数字が直接前置される書き方はそもそもC++として
// 構文が成立しない)ため、この判定で本物の文字リテラルを誤検知することはない。
const HEX_DIGIT_RE = /[0-9a-fA-F]/;
function isDigitSeparatorApostrophe(line: string, idx: number): boolean {
  const prev = idx > 0              ? line[idx - 1] : '';
  const next = idx + 1 < line.length ? line[idx + 1] : '';
  return HEX_DIGIT_RE.test(prev) && HEX_DIGIT_RE.test(next);
}

function extractCallsFromLines(
  lines: string[], start: number, end: number,
  selfName: string, knownTags?: Set<string>
): Set<string> {
  const callees        = new Set<string>();
  const re             = /\b([A-Za-z_]\w*)\s*\(/g;
  let   inBlockComment = false;
  let   rawDelimiter   = ''; // RAW文字列の終端デリミタ。空文字列なら非RAW状態

  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
    const line = lines[i];
    let   processed: string[] = []; // A: string += ch は O(n²) → 配列 + join('') で O(n) に
    let   j         = 0;

    while (j < line.length) {
      // ── RAW文字列状態 ──────────────────────────────────────────
      if (rawDelimiter) {
        const endIdx = line.indexOf(rawDelimiter, j);
        if (endIdx === -1) {
          j = line.length; // 行末まで RAW 文字列継続
        } else {
          j = endIdx + rawDelimiter.length;
          rawDelimiter = ''; // RAW 文字列終端
        }
        continue;
      }

      if (inBlockComment) {
        const endIdx = line.indexOf('*/', j);
        if (endIdx === -1) { j = line.length; }
        else { inBlockComment = false; j = endIdx + 2; }
        continue;
      }

      const ch  = line[j];
      const ch2 = j + 1 < line.length ? line[j] + line[j + 1] : '';

      // R"delimiter(...)delimiter" の開始検出
      // 'R' の次が '"' のとき RAW 文字列リテラル開始
      if (ch === 'R' && j + 1 < line.length && line[j + 1] === '"') {
        j += 2; // R" をスキップ
        const parenIdx = line.indexOf('(', j);
        if (parenIdx === -1) {
          // '(' なし → 通常の識別子 R として扱う
          processed.push(ch);
        } else {
          const delim  = line.slice(j, parenIdx); // R"DELIM( の DELIM 部分
          const terminator = ')' + delim + '"';   // 終端は )DELIM"
          j = parenIdx + 1;
          // 同一行内に終端があるか確認
          const endIdx = line.indexOf(terminator, j);
          if (endIdx !== -1) {
            j = endIdx + terminator.length; // 同一行内で終端
          } else {
            rawDelimiter = terminator; // 次の行に継続
            j = line.length;
          }
        }
        continue;
      }

      if (ch === '"') {
        // 二重引用符文字列: 次の unescaped " まで読み飛ばす
        j++;
        while (j < line.length) {
          if (line[j] === '\\') { j += 2; }
          else if (line[j] === '"') { j++; break; }
          else { j++; }
        }
      } else if (ch === "'" && isDigitSeparatorApostrophe(line, j)) {
        // C++14 桁区切り文字: 文字リテラルには入らず読み飛ばすだけにする
        // (processed には含めない。区切りの有無は識別子境界に影響しないため)。
        j++;
      } else if (ch === "'") {
        // 文字リテラル: 次の unescaped ' まで読み飛ばす
        j++;
        while (j < line.length) {
          if (line[j] === '\\') { j += 2; }
          else if (line[j] === "'") { j++; break; }
          else { j++; }
        }
      } else if (ch2 === '//') {
        j = line.length; // 行末コメント
      } else if (ch2 === '/*') {
        inBlockComment = true;
        j += 2;
      } else {
        processed.push(ch);
        j++;
      }
    }

    const processedStr = processed.join('');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(processedStr)) !== null) {
      const callee = m[1];
      // knownTags が指定されている場合のみフィルタ (省略時は全候補を返す)
      // N2修正: 「型 名前(...)」の形の宣言・前方宣言は呼び出しではないため除外する
      if (callee !== selfName && (!knownTags || knownTags.has(callee))
          && !isDeclarationPrefix(processedStr.slice(0, m.index))) callees.add(callee);
    }
  }
  return callees;
}

/**
 * callee スコープを解決する。
 * calleeEntry.line が既知の場合は findScopeAtLine（行番号優先）を使い、
 * 同一ファイル内に同名関数が複数ある場合でも正しいスコープを返す。
 * findScopeAtLine が失敗した場合のみ byName にフォールバックする。
 */
function resolveCalleeScope(
  scopeMap: Map<string, ScopeMapEntry>,
  file:     string,
  name:     string,
  line:     number
): ScopeEntry | undefined {
  const entry = scopeMap.get(file);
  if (!entry) return undefined;
  return findScopeAtLine(entry.list, line) ?? entry.byName.get(name);
}


/**
 * resolveCallee() が「自信のない解決」をした場合に記録する情報。
 * (優先順位①=callerFileと同一ファイル+isFunc、で確実に決着できず、
 *  複数ファイルにまたがる候補からヒューリスティックに選んだ場合のみ記録される)
 */
interface UncertainResolution {
  name:       string;
  callerFile: string;
  candidates: GtagEntry[];
  picked:     GtagEntry;
}

/**
 * 複数の UncertainResolution を集約して警告メッセージ(最大1件)に変換する。
 * 同一 (callerFile, name) の重複はBFS中に何度も記録されうるため、表示前に去重する。
 */
function formatUncertainResolutions(uncertain: UncertainResolution[]): string[] {
  if (uncertain.length === 0) return [];
  const seen = new Set<string>();
  const unique: UncertainResolution[] = [];
  for (const u of uncertain) {
    const key = `${u.callerFile}\x00${u.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(u);
  }
  const describe = (u: UncertainResolution): string => {
    const others = u.candidates
      .filter(c => c !== u.picked)
      .map(c => `${path.basename(c.file)}:${c.line}`)
      .join(', ');
    return `${path.basename(u.callerFile)} → ${u.name} (chose ${path.basename(u.picked.file)}:${u.picked.line}; other candidates: ${others})`;
  };
  const preview = unique.slice(0, 5).map(describe).join(' / ');
  const suffix  = unique.length > 5 ? ` and ${unique.length - 5} more` : '';
  return [`[gtags] Uncertain call resolution for ${unique.length} call(s) ` +
    `(same name in multiple files, caller not co-located with any of them): ${preview}${suffix}`];
}

/**
 * callee エントリを全候補から解決する。
 * 優先順位: 1. callerFile と同ファイル + isFunc（static 関数）
 *           2. 任意ファイルの isFunc
 *           3. フォールバック（先頭候補）
 *
 * 優先順位1はC言語の名前解決規則(static関数はそのファイルからしか呼べない)そのものなので
 * 確実に正しい。優先順位2/3は単なるヒューリスティック(候補配列の順序依存)であり、
 * 複数ファイルにまたがる同名候補が存在する状態でここに落ちた場合は、誤接続の可能性がある。
 * uncertain を渡すと、その「自信のない解決」だけを記録する
 * (単に同名が複数ファイルにあるだけでは記録しない。通常のクロスファイル呼び出しの
 *  大半が該当してしまいノイズになるため)。
 */
/**
 * N1修正: 呼び出し元と同じファイルに候補が無い場合、以前は global -x の出力順
 * (≒パスの辞書順)で最初の関数を無条件に採用していたため、build/ 配下のコピーや
 * vendor の複製、別言語(C++)の同名関数が、正しい候補より先に選ばれることがあった
 * (Path-Through Graphで本来の呼び出し元が消える、誤エッジが混入する等)。
 * 「近さ」で順位付けする: ① 除外ディレクトリ(build/vendor等)配下の候補を後回し
 * ② 呼び出し元ディレクトリからの距離が近い候補を優先 ③ C/C++の言語不一致を後回し
 * ④ それでも決まらなければ従来通り出力順。
 */
function candidateRank(callerFile: string, cand: GtagEntry): [number, number, number] {
  const CPP_EXT_RE = /\.(cpp|cc|cxx|c\+\+|hpp|hh|hxx|h\+\+|inl|ipp|tpp|tcc)$/i;
  const C_EXT_RE   = /\.c$/i;
  const a = path.dirname(callerFile).split(/[\\/]/);
  const b = path.dirname(cand.file).split(/[\\/]/);
  let i = 0;
  while (i < a.length && i < b.length && normalizeFsPath(a[i]) === normalizeFsPath(b[i])) i++;
  // 共有しない部分だけを見る(ワークスペース自体が build/ 配下にあっても誤判定しない)
  const excluded = b.slice(i).some(seg => EXCLUDE_DIRS.has(seg)) ? 1 : 0;
  const dist     = (a.length - i) + (b.length - i);
  const mismatch = ((C_EXT_RE.test(callerFile) && CPP_EXT_RE.test(cand.file)) ||
                    (CPP_EXT_RE.test(callerFile) && C_EXT_RE.test(cand.file))) ? 1 : 0;
  return [excluded, dist, mismatch];
}

function pickBestCandidate(candidates: GtagEntry[], callerFile: string): GtagEntry {
  const funcs = candidates.filter(c => c.isFunc);
  const pool  = funcs.length > 0 ? funcs : candidates;
  const ranked = pool.map((c, idx) => ({ c, idx, r: candidateRank(callerFile, c) }));
  ranked.sort((x, y) =>
    (x.r[0] - y.r[0]) || (x.r[1] - y.r[1]) || (x.r[2] - y.r[2]) || (x.idx - y.idx));
  return ranked[0].c;
}

function resolveCallee(
  candidates: GtagEntry[] | undefined,
  callerFile: string,
  uncertain?: UncertainResolution[],
): GtagEntry | undefined {
  if (!candidates?.length) return undefined;
  const exact = candidates.find(c => c.file === callerFile && c.isFunc);
  if (exact) return exact;
  const picked = pickBestCandidate(candidates, callerFile);
  if (uncertain) {
    const distinctFiles = new Set(candidates.map(c => c.file));
    if (distinctFiles.size > 1) uncertain.push({ name: picked.name, callerFile, candidates, picked });
  }
  return picked;
}


/**
 * global -rx -e '^(func1|func2|...)$' を buildPatternBatches で動的分割し、
 * GLOBAL_RX_PARALLEL 個ずつ並列実行してエッジセットを構築する。
 * GNU Global のシンボル DB を使うためコメント・文字列リテラルとの誤混同がない。
 * -e フラグ（POSIX 拡張正規表現）は GNU Global 5.0 以降が必要。
 */
async function buildEdgesGlobalRx(
  callerFiles: Set<string>,
  tags:        Map<string, GtagEntry[]>,
  scopeMap:    Map<string, ScopeMapEntry>,
  wsRoot:      string,
  token?:      vscode.CancellationToken,
  pct?:        Pct,
  startPct     = 20,
  endPct       = 75,
  errs:        string[] = [],
  wsRoots?:    string[],
  uncertain?:  UncertainResolution[],
): Promise<Set<string>> {
  const effectiveRoots = (wsRoots && wsRoots.length > 0) ? wsRoots : [wsRoot];
  const edgeSet = new Set<string>();

  const funcNames = Array.from(tags.entries())
    .filter(([, entries]) => entries.some(e => e.isFunc))
    .map(([name]) => name);

  const { patterns, skipped } = buildPatternBatches(funcNames);
  const totalGroups = Math.ceil(patterns.length / GLOBAL_RX_PARALLEL);
  if (skipped > 0) errs.push(
    `[gtags] Skipped ${skipped} identifier(s) too long for GNU GLOBAL pattern matching. ` +
    'Call edges for these functions may be missing from the graph.');

  // 同一エラーを集約するための一時セット（GNU GLOBAL < 5.0 で -e 未サポートの場合など
  // 全バッチが同じエラーになる場合に重複を防ぐ）
  const errorMessages = new Set<string>();
  // #1修正: sanitizeToAnyWsRoot が null を返した(=空白入りフォルダ名等でパスが
  // 千切れて復元できなかった)件数。runGlobalXAll(collectGtags 経由の初回タグ収集)
  // にしか無かった警告を、この下方向エッジ構築経路にも用意する。
  let droppedRefCount = 0;

  for (let gi = 0; gi < patterns.length; gi += GLOBAL_RX_PARALLEL) {
    checkCancellation(token);
    pct?.range(startPct, endPct, Math.floor(gi / GLOBAL_RX_PARALLEL), totalGroups);

    await Promise.all(patterns.slice(gi, gi + GLOBAL_RX_PARALLEL).map(async pattern => {
      let stdout = '';
      try {
        ({ stdout } = await execFileAsync('global', ['-rx', '-e', pattern], {
          cwd: wsRoot, maxBuffer: 50 * 1024 * 1024, timeout: 60_000,
        }));
      } catch (e) {
        const ex  = e as NodeJS.ErrnoException & { killed?: boolean };
        const msg = ex instanceof Error ? ex.message : String(ex);
        if (ex.killed || msg.includes('cancel')) { return; }
        if (msg.includes('maxBuffer') || msg.includes('STDIO_MAXBUFFER') || msg.includes('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
          errorMessages.add(
            '[gtags] global -rx: Output too large (>50MB). ' +
            'Some call edges may be missing. ' +
            'Consider splitting the analysis with Folder Graph.'
          );
          return;
        }
        const firstLine = msg.split('\n')[0];
        // -e フラグ未サポートの場合に分かりやすいメッセージに変換する
        const isUnsupportedE = /invalid option|unknown option|illegal option/i.test(firstLine);
        const normalized = isUnsupportedE
          ? 'global -rx: -e flag not supported (GNU GLOBAL < 5.0). ' +
            'Using regex fallback for callee detection. Upgrade to GLOBAL 5.0+ for better accuracy.'
          : `global -rx: ${firstLine}`;
        errorMessages.add(normalized);
        return;
      }

      for (const rawLine of stdout.split('\n')) {
        const parts = rawLine.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const calleeName = parts[0];
        const refLine    = parseInt(parts[1], 10);
        if (!calleeName || isNaN(refLine)) continue;
        // N2修正: この参照行自体が calleeName の宣言(前方宣言・クラス内メンバ宣言等)
        // であれば、呼び出しとしては数えない。
        if (isDeclarationRef(parts.slice(3).join(' '), calleeName)) continue;
        const refFile = sanitizeToAnyWsRoot(parts[2], effectiveRoots);
        // normalizeFsPath を通した正規化済みパスで比較（macOS/Windows の大文字小文字・区切り文字の差異を吸収）
        // #1修正: refFile が null になるのは「空白入りフォルダ名等でパスが解決できなかった」
        // という異常系であり、callerFiles に含まれないだけの正常な絞り込み(他ファイルからの参照)
        // とは区別してカウントする。
        if (!refFile) { droppedRefCount++; continue; }
        if (!callerFiles.has(normalizeFsPath(refFile))) continue;
        const fileScopeEntry = findScopeMapEntry(scopeMap, refFile);
        if (!fileScopeEntry) continue;
        const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
        if (!callerScope) continue;
        const callerEntry = tags.get(callerScope.name)
          ?.find(e => e.file === refFile && e.isFunc)
          ?? resolveCallee(tags.get(callerScope.name), refFile);
        if (!callerEntry) continue;
        // resolveCallee のフォールバックで別ファイルのエントリが返った場合はスキップする
        if (callerEntry.file !== refFile) continue;
        const calleeEntry = resolveCallee(tags.get(calleeName), refFile, uncertain);
        if (!calleeEntry?.isFunc) continue;
        const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, calleeName, calleeEntry.line);
        if (!calleeScope) continue;
        if (callerScope.name === calleeName && callerEntry.file === calleeEntry.file) continue;
        // callerEntry.file === refFile が保証されているため、どちらを使っても同値。
        // 意図を明示するため callerEntry.file を使う（gtagsBfsUpFull/Lazy と統一）。
        const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);
        const calleeId = makeGtagsNodeId(calleeEntry.file, calleeName, calleeEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);
      }
    }));
  }
  // ループ外でまとめて push（ループ内で都度 push すると同一エラーが N 件になる）
  for (const msg of errorMessages) errs.push(msg);
  if (droppedRefCount > 0) errs.push(
    `[gtags] Skipped ${droppedRefCount} reference(s) whose file path could not be resolved ` +
    '(likely a folder name containing spaces). Some caller edges may be missing from the graph.');
  return edgeSet;
}

/**
 * GtagEntry + ScopeEntry から GraphNode を生成する。
 * source はクリック時のオンデマンド読み込みで設定するためここでは設定しない。
 * 代わりに scopeEnd を保持し、webviewPanel の requestSource ハンドラが利用する。
 */
function gtagsEntryToNode(
  name: string, entry: GtagEntry, scope: ScopeEntry, currentFile: string
): GraphNode {
  const scopeEnd = scope.end === Number.MAX_SAFE_INTEGER
    ? scope.start + MAX_SOURCE_LINES - 1
    : scope.end;
  // B: normalizeFsPath で比較してシンボリックリンク環境でも正しく判定する
  const isCurrentFile = currentFile !== ''
    && normalizeFsPath(entry.file) === normalizeFsPath(currentFile);
  return {
    id:            makeGtagsNodeId(entry.file, name, entry.line),
    label:         name,
    labelFull:     entry.sourceLine || name,
    file:          entry.file,
    line:          entry.line,
    scopeEnd,
    isCurrentFile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  内部 BFS エンジン
// ─────────────────────────────────────────────────────────────────────────────

// ── 内部 BFS エンジン ─────────────────────────────────────────────────────────

interface GtagsBfsDownFullOpts {
  nodes:      Map<string, GraphNode>;
  edgeSet:    Set<string>;
  errs:       string[];
  uncertain:  UncertainResolution[];
  tags:       Map<string, GtagEntry[]>;
  scopeMap:   Map<string, ScopeMapEntry>;
  lineCache:  Map<string, string[]>;
  wsRoot:     string;
  currentFile: string;
  startItems: Array<{ name: string; entry: GtagEntry; scope: ScopeEntry }>;
  maxHops?:   number;
  token?:     vscode.CancellationToken;
  pct:        Pct;
  pctRange:   [number, number];
}

/** gtags 下方向 BFS（全量キャッシュ版）。extractCallsFromLines + resolveCallee で展開する。 */
async function gtagsBfsDownFull(opts: GtagsBfsDownFullOpts): Promise<void> {
  const { nodes, edgeSet, tags, scopeMap, lineCache, currentFile, startItems, maxHops, token, pct, pctRange, uncertain } = opts;
  const knownTags = new Set(tags.keys());
  type QItem = { name: string; entry: GtagEntry; scope: ScopeEntry; hop: number };
  const queue:   QItem[]      = startItems.map(s => ({ ...s, hop: 0 }));
  const visited  = new Set<string>(startItems.map(s => makeGtagsNodeId(s.entry.file, s.name, s.entry.line)));
  let qi = 0;
  while (qi < queue.length) {
    checkCancellation(token);
    const { name, entry, scope, hop } = queue[qi++];
    const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
    const lines  = await getFileLinesAsync(entry.file, lineCache);
    if (!nodes.has(nodeId)) nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, currentFile));
    pct.bfsQ(pctRange[0], pctRange[1], visited, { length: queue.length - qi });
    if (maxHops !== undefined && hop >= maxHops) continue;
    for (const callee of extractCallsFromLines(lines, scope.start, scope.end, name, knownTags)) {
      const calleeEntry = resolveCallee(tags.get(callee), entry.file, uncertain);
      if (!calleeEntry?.isFunc) continue;
      const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, callee, calleeEntry.line);
      if (!calleeScope) continue;
      const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
      edgeSet.add(`${nodeId}|||${calleeId}`);
      if (!nodes.has(calleeId)) nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, currentFile));
      if (!visited.has(calleeId)) { visited.add(calleeId); queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 }); }
    }
  }
}

interface GtagsBfsUpFullOpts {
  nodes:      Map<string, GraphNode>;
  edgeSet:    Set<string>;
  errs:       string[];
  uncertain:  UncertainResolution[];
  tags:       Map<string, GtagEntry[]>;
  scopeMap:   Map<string, ScopeMapEntry>;
  wsRoot:     string;
  wsRoots:    string[];
  currentFile: string;
  startItems: Array<{ funcName: string; calleeId: string }>;
  maxHops?:   number;
  token?:     vscode.CancellationToken;
  pct:        Pct;
  pctRange:   [number, number];
}

/** gtags 上方向 BFS (全量キャッシュ版)。level-by-level + runGlobalRxBatch で遡る。 */
async function gtagsBfsUpFull(opts: GtagsBfsUpFullOpts): Promise<void> {
  const { nodes, edgeSet, errs, tags, scopeMap, wsRoot, wsRoots, currentFile, startItems, maxHops, token, pct, pctRange, uncertain } = opts;
  const upQueued = new Set<string>(startItems.map(s => s.calleeId));
  let upCurrentLevel = [...startItems];
  let hop = 0;
  while (upCurrentLevel.length > 0 && (maxHops === undefined || hop < maxHops)) {
    checkCancellation(token);
    const refMap = await runGlobalRxBatch(upCurrentLevel.map(s => s.funcName), wsRoot, errs, wsRoots);
    const upNextLevel: typeof startItems = [];
    for (const { funcName, calleeId } of upCurrentLevel) {
      // isSelfRef の比較ファイルは calleeId から確定した callee 自身のファイルを使う。
      // tags.get(funcName)?.find(...) は同名関数が複数ファイルにある場合に
      // 別ファイルを返すことがあり、正当な caller を誤ってスキップしてしまう。
      const { file: calleeFile } = parseGtagsNodeId(calleeId);
      for (const { refFile, refLine, srcLine } of refMap.get(funcName) ?? []) {
        checkCancellation(token);
        // N2修正: この参照が funcName 自身の宣言(前方宣言等)であれば、
        // 呼び出し元として数えない(呼び出し元でなく単なる宣言のため)。
        if (isDeclarationRef(srcLine, funcName)) continue;
        const fileScopeEntry = findScopeMapEntry(scopeMap, refFile);
        if (!fileScopeEntry) continue;
        const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
        // 自己参照（callee と同一ファイル・同一スコープ名）のみスキップする。
        // 別ファイルの同名関数は正当な caller なので除外しない。
        const isSelfRef = callerScope?.name === funcName
          && normalizeFsPath(refFile) === normalizeFsPath(calleeFile);
        if (!callerScope || isSelfRef) continue;
        const callerEntry =
          tags.get(callerScope.name)?.find(e => e.file === refFile && e.isFunc)
          ?? resolveCallee(tags.get(callerScope.name), refFile);
        if (!callerEntry) continue;
        // resolveCallee のフォールバックで別ファイルのエントリが返ると
        // 孤立エッジが生まれるためスキップする。
        if (callerEntry.file !== refFile) continue;
        // refFile 側から funcName を実際に解決した結果が、今展開中の calleeFile と
        // 一致するかを確認する。同名関数が複数ファイルに存在する場合(static 関数の
        // 重複)、refFile は自分自身のファイル内の同名関数を呼んでいるだけの可能性が
        // あるため、ここで検証しないと無関係な同名関数同士が誤って繋がってしまう
        // (例: clone が 20 ファイルにある場合、mod_005.c の呼び出しが
        //  mod_099.c の clone への着信として誤集計されるバグがあった)。
        const trueTarget = resolveCallee(tags.get(funcName), refFile, uncertain);
        if (!trueTarget || normalizeFsPath(trueTarget.file) !== normalizeFsPath(calleeFile)) continue;
        const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);
        if (!nodes.has(callerId)) nodes.set(callerId, gtagsEntryToNode(callerScope.name, callerEntry, callerScope, currentFile));
        if (!upQueued.has(callerId)) { upQueued.add(callerId); upNextLevel.push({ funcName: callerScope.name, calleeId: callerId }); }
      }
    }
    pct.range(pctRange[0], pctRange[1], hop + 1, maxHops ?? hop + 2);
    upCurrentLevel = upNextLevel;
    hop++;
  }
  // ループが maxHops 未満で収束した場合も確実に pctRange[1] まで進める
  pct.to(pctRange[1]);
}

interface GtagsBfsDownLazyOpts {
  nodes:       Map<string, GraphNode>;
  edgeSet:     Set<string>;
  errs:        string[];
  uncertain:   UncertainResolution[];
  startEntry:  { name: string; entry: GtagEntry; scope: ScopeEntry };
  tagCache:    Map<string, GtagEntry[]>;
  scopeCache:  Map<string, ScopeMapEntry>;
  lineCache:   Map<string, string[]>;
  wsRoot:      string;
  wsRoots:     string[]; // マルチルート対応
  currentFile: string;
  maxHops?:    number;
  token?:      vscode.CancellationToken;
  pct:         Pct;
  pctRange:    [number, number];
}

/**
 * gtags 下方向 BFS（全量キャッシュ版）。
 * visited（処理完了）と queued（投入済み）を分離してサイクルによる二重処理を防ぐ。
 */
async function gtagsBfsDownLazy(opts: GtagsBfsDownLazyOpts): Promise<void> {
  const { nodes, edgeSet, errs, startEntry, tagCache, scopeCache, lineCache, wsRoot, wsRoots, currentFile, maxHops, token, pct, pctRange, uncertain } = opts;
  const startNodeId = makeGtagsNodeId(startEntry.entry.file, startEntry.name, startEntry.entry.line);
  type Q = { name: string; entry: GtagEntry; scope: ScopeEntry; hop: number };
  const queue:   Q[]          = [{ ...startEntry, hop: 0 }];
  const visited  = new Set<string>();
  const queued   = new Set<string>([startNodeId]);
  let qi = 0;
  while (qi < queue.length) {
    checkCancellation(token);
    const { name, entry, scope, hop } = queue[qi++];
    const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const lines = await getFileLinesAsync(entry.file, lineCache);
    nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, currentFile));

    // N3修正: maxHops到達ノードの「その先のcallee」を登録だけ行っていたため、
    // maxHops=1 でも2ホップ先まで表示される(LSP/gtagsBfsDownFullとズレる)バグがあった。
    // hop >= maxHops の時点で、このノード自体は既に登録済み(978行目)なので、
    // それより先は展開もノード登録も一切行わずスキップする。
    if (maxHops !== undefined && hop >= maxHops) continue;
    const rawCandidates = extractCallsFromLines(lines, scope.start, scope.end, name);
    if (rawCandidates.size > 0) {
      const uncached = [...rawCandidates].filter(c => !tagCache.has(c));
      if (uncached.length > 0) {
        const freshMap = await runGlobalXNames(uncached, wsRoot, errs, wsRoots);
        for (const [n, es] of freshMap) tagCache.set(n, es);
        for (const n of uncached) { if (!tagCache.has(n)) tagCache.set(n, []); }
      }
      const resolvedCallees: Array<{ callee: string; calleeEntry: GtagEntry }> = [];
      for (const callee of rawCandidates) {
        const calleeEntry = resolveCallee(tagCache.get(callee), entry.file, uncertain);
        if (calleeEntry?.isFunc) resolvedCallees.push({ callee, calleeEntry });
      }
      await Promise.all([...new Set(resolvedCallees.map(c => c.calleeEntry.file))].map(f =>
        buildScopeForFileCached(f, wsRoot, scopeCache, lineCache, wsRoots)));
      for (const { callee, calleeEntry } of resolvedCallees) {
        const calleeScopeEntry = scopeCache.get(normalizeFsPath(calleeEntry.file)) ?? scopeCache.get(calleeEntry.file);
        if (!calleeScopeEntry) continue;
        const calleeScope = findScopeAtLine(calleeScopeEntry.list, calleeEntry.line) ?? calleeScopeEntry.byName.get(callee);
        if (!calleeScope) continue;
        const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
        edgeSet.add(`${nodeId}|||${calleeId}`);
        if (!queued.has(calleeId)) { queued.add(calleeId); queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 }); }
      }
    }
    pct.bfsQ(pctRange[0], pctRange[1], queued, { length: queue.length - qi });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  遅延ローディング用ヘルパー
//   BFS を進めながら必要な関数・ファイルだけをオンデマンドでクエリする。
//   buildFunctionCallGraphGtags / buildPathThroughCallGraphGtags で共用する。
// ─────────────────────────────────────────────────────────────────────────────

async function runGlobalRxBatch(
  funcNames: string[],
  wsRoot:    string,
  errs:      string[] = [],
  wsRoots?:  string[],
): Promise<Map<string, Array<{ refFile: string; refLine: number; srcLine: string }>>> {
  const result = new Map<string, Array<{ refFile: string; refLine: number; srcLine: string }>>();
  for (const n of funcNames) result.set(n, []);
  if (funcNames.length === 0) return result;
  const effectiveRoots = (wsRoots && wsRoots.length > 0) ? wsRoots : [wsRoot];
  const { patterns, skipped } = buildPatternBatches(funcNames);
  if (skipped > 0) errs.push(
    `[gtags] Skipped ${skipped} identifier(s) too long for GNU GLOBAL pattern matching. ` +
    'Call edges for these functions may be missing from the graph.');
  const errorMessages = new Set<string>();
  // #1修正: buildEdgesGlobalRx と同じ理由(sanitizeToAnyWsRoot が null を返すケースの警告)。
  // この関数は File/Workspace/Path-Through Graph の上方向(caller) BFS 全てで使われる
  // 共通経路のため、ここで警告できれば効果範囲が広い。
  let droppedRefCount = 0;
  // マルチルート対応: GNU GLOBAL は cwd 直下の GTAGS/GRTAGS/GPATH しか検索しないため、
  // effectiveRoots の各 root を cwd に切り替えて個別に検索し、結果を同じ result にマージする。
  // (buildEdgesGlobalRx の呼び出し元ループと同じ考え方を、この関数内部に持ち込んだもの)
  for (const root of effectiveRoots) {
    // GLOBAL_RX_PARALLEL 個ずつ逐次バッチ実行（全パターン同時起動によるリソース枯渇を防ぐ）
    for (let gi = 0; gi < patterns.length; gi += GLOBAL_RX_PARALLEL) {
      await Promise.all(patterns.slice(gi, gi + GLOBAL_RX_PARALLEL).map(async pattern => {
        let stdout = '';
        try {
          ({ stdout } = await execFileAsync('global', ['-rx', '-e', pattern], {
            cwd: root, maxBuffer: 50 * 1024 * 1024, timeout: 60_000,
          }));
        } catch (e) {
          const ex  = e as NodeJS.ErrnoException & { killed?: boolean };
          const msg = ex instanceof Error ? ex.message : String(ex);
          if (ex.killed || msg.includes('cancel')) return;
          errorMessages.add(`global -rx: ${msg.split('\n')[0]}`);
          return;
        }
        for (const raw of stdout.split('\n')) {
          const parts = raw.trim().split(/\s+/);
          if (parts.length < 3) continue;
          const name    = parts[0];
          const refLine = parseInt(parts[1], 10);
          if (!name || isNaN(refLine)) continue;
          // name にセパレータ文字が含まれる場合はスキップ
          if (name.includes('\x00') || name.includes('|||')) continue;
          const refFile = sanitizeToAnyWsRoot(parts[2], effectiveRoots);
          if (!refFile) { droppedRefCount++; continue; }
          result.get(name)?.push({ refFile, refLine, srcLine: parts.slice(3).join(' ') });
        }
      }));
    }
  }
  for (const msg of errorMessages) errs.push(msg);
  if (droppedRefCount > 0) errs.push(
    `[gtags] Skipped ${droppedRefCount} reference(s) whose file path could not be resolved ` +
    '(likely a folder name containing spaces). Some caller edges may be missing from the graph.');
  return result;
}


// GNU GLOBAL 内部バッファ上限は 512 バイト固定。
// global -rx に渡すパターンは ^(中身)$ の形式で、オーバーヘッドが 4 バイトあるため
// 中身の実質上限は 508 バイトになる。
// 512 バイトを超えると global が buffer overflow で exit 1 する。
// 400 は 508 バイトに対して十分な余裕を持たせた値。
const MAX_PATTERN_LENGTH = 400;

/**
 * アンカー付き ERE パターンのバッチ配列を生成する。
 * ^ と $ アンカーで部分一致を防止し（例: 'func1' が 'func1_helper' にマッチしない）、
 * MAX_PATTERN_LENGTH を超えないよう動的分割する。
 * runGlobalXNames と runGlobalRxBatch の両方で共用する。
 */
interface PatternBatchResult {
  patterns: string[];
  /** MAX_PATTERN_LENGTH を超えるため無視された識別子の数(N6修正: 呼び出し元で警告するため)。 */
  skipped:  number;
}

function buildPatternBatches(names: string[]): PatternBatchResult {
  if (names.length === 0) return { patterns: [], skipped: 0 };
  const batches: string[] = [];
  let batch: string[] = [];
  const WRAPPER_LEN = 4; // '^(' + ')$'
  let len = WRAPPER_LEN;
  let skipped = 0;

  for (const name of names) {
    const escaped = escapeRegexForGlobal(name);
    // C++ のテンプレート特殊化など極端に長い関数名で buildPatternBatches が停止しなくなる問題を防ぐ。
    // N6修正: 以前はここで無警告のまま continue していたため、スキップされた関数だけ
    // 一括検索(global -rx/-x)の対象から外れ、原因不明の「孤立ノード」に見えていた。
    if (WRAPPER_LEN + escaped.length > MAX_PATTERN_LENGTH) { skipped++; continue; }
    // 分割するかどうかの判定は「リセット前の batch」を基準に行う。
    if (len + (batch.length > 0 ? 1 : 0) + escaped.length > MAX_PATTERN_LENGTH && batch.length > 0) {
      batches.push('^(' + batch.join('|') + ')$');
      batch = []; len = WRAPPER_LEN;
    }
    // 微小修正: add は上の分割判定でリセットされた"後"の batch.length を基準に計算し直す。
    // (以前はリセット前の batch.length>0 を使い回していたため、リセット直後で
    //  セパレータ '|' が不要な最初の要素にも +1 してしまい、実際のバイト数より
    //  1バイト大きく見積もっていた。安全側の誤差ではあるが、正確性のため修正)
    const add = (batch.length > 0 ? 1 : 0) + escaped.length;
    batch.push(escaped);
    len += add;
  }
  if (batch.length > 0) batches.push('^(' + batch.join('|') + ')$');
  return { patterns: batches, skipped };
}

/**
 * 指定した関数名リストの定義エントリを global -x -e '^(func1|func2|...)$' で一括取得する。
 * runGlobalXAll の全ダンプ版に対する、部分クエリ版。
 * buildPatternBatches で動的分割した複数パターンを並列実行し Map<name, GtagEntry[]> で返す。
 */
async function runGlobalXNames(
  names:   string[],
  wsRoot:  string,
  errs:    string[] = [],
  wsRoots?: string[],
): Promise<Map<string, GtagEntry[]>> {
  const result = new Map<string, GtagEntry[]>();
  if (names.length === 0) return result;

  const effectiveRoots = (wsRoots && wsRoots.length > 0) ? wsRoots : [wsRoot];
  const { patterns, skipped } = buildPatternBatches(names);
  if (skipped > 0) errs.push(
    `[gtags] Skipped ${skipped} identifier(s) too long for GNU GLOBAL pattern matching. ` +
    'These definitions may be missing from the graph.');
  const errorMessages = new Set<string>(); // 重複除去
  // #1修正: buildEdgesGlobalRx / runGlobalRxBatch と同じ理由。この関数は
  // Function Graph (BFS) コマンドが使う唯一のBFS経路であり、これまで
  // ここだけ警告が一切無かった(README記載の警告が出ない直接の原因)。
  let droppedRefCount = 0;

  // マルチルート対応: runGlobalRxBatch と同様に effectiveRoots の各 root を cwd に切り替えて
  // 個別に検索し、結果を同じ result にマージする。
  for (const root of effectiveRoots) {
    // GLOBAL_RX_PARALLEL 上限付きバッチ並列（runGlobalRxBatch と統一）
    for (let gi = 0; gi < patterns.length; gi += GLOBAL_RX_PARALLEL) {
      await Promise.all(patterns.slice(gi, gi + GLOBAL_RX_PARALLEL).map(async pattern => {
        let stdout = '';
        try {
          ({ stdout } = await execFileAsync('global', ['-x', '-e', pattern], {
            cwd: root, maxBuffer: 10 * 1024 * 1024, timeout: 30_000,
          }));
        } catch (e) {
          const ex  = e as NodeJS.ErrnoException & { killed?: boolean };
          const msg = ex instanceof Error ? ex.message : String(ex);
          if (ex.killed || msg.includes('cancel')) { return; }
          errorMessages.add(`global -x: ${msg.split('\n')[0]}`);
          return;
        }

        for (const raw of stdout.split('\n')) {
          const trimmed = raw.trimEnd();
          if (!trimmed) continue;
          const m = trimmed.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/);
          if (!m) continue;
          const [, name, lineStr, fileStr, sourceLine] = m;
          const line = parseInt(lineStr, 10);
          if (isNaN(line)) continue;
          // name にセパレータが含まれる場合はスキップ
          if (!name || name.includes('\x00') || name.includes('|||')) continue;
          const file = sanitizeToAnyWsRoot(fileStr, effectiveRoots);
          if (!file) { droppedRefCount++; continue; }
          const entry: GtagEntry = { name, file, line, sourceLine, isFunc: isLikelyFuncDef(sourceLine) };
          if (!result.has(name)) result.set(name, []);
          result.get(name)!.push(entry);
        }
      }));
    }
  }

  for (const msg of errorMessages) errs.push(msg);
  if (droppedRefCount > 0) errs.push(
    `[gtags] Skipped ${droppedRefCount} definition(s) whose file path could not be resolved ` +
    '(likely a folder name containing spaces). Some functions may be missing from the graph.');
  return result;
}

/**
 * tagCache に name のエントリがあれば返し、なければ runGlobalXNames でフェッチしてキャッシュする。
 * キャッシュミス時の二重フェッチを防ぐため、未ヒット時は空配列もキャッシュする。
 */
async function resolveOrFetchTag(
  name:     string,
  wsRoot:   string,
  tagCache: Map<string, GtagEntry[]>,
  errs:     string[] = [],
  wsRoots?: string[],
): Promise<GtagEntry[] | undefined> {
  if (tagCache.has(name)) {
    const cached = tagCache.get(name)!;
    return cached.length > 0 ? cached : undefined;
  }
  const resolved = await runGlobalXNames([name], wsRoot, errs, wsRoots);
  const entries  = resolved.get(name) ?? [];
  tagCache.set(name, entries); // 空配列もキャッシュして再フェッチを防止
  return entries.length > 0 ? entries : undefined;
}

/**
 * global -f <file> を使って fileScopeCache に ScopeMapEntry を構築して返す。
 * isFunc 判定のため lineCache からファイル行を読む（未保存変更も反映される）。
 *
 * @param file         対象ファイルの絶対パス
 * @param wsRoot       GTAGS のあるワークスペースルート
 * @param scopeCache   ビルド内で共有するスコープキャッシュ
 * @param lineCache    ビルド内で共有する行キャッシュ
 */
async function buildScopeForFileCached(
  file:       string,
  wsRoot:     string,
  scopeCache: Map<string, ScopeMapEntry>,
  lineCache:  Map<string, string[]>,
  wsRoots?:   string[],
): Promise<ScopeMapEntry | undefined> {
  const norm = normalizeFsPath(file);
  const hit  = scopeCache.get(norm) ?? scopeCache.get(file);
  if (hit) return hit;

  // file が wsRoot と異なるルートに属する場合は getWorkspaceRootForFile で動的解決する。
  // path.relative(wsRoot, file) が '../other-root/...' になると global -f が空を返すため。
  const effectiveRoot = (wsRoots && wsRoots.length > 0)
    ? (getWorkspaceRootForFile(vscode.Uri.file(file)) ?? wsRoot)
    : wsRoot;
  const tagEntries = await runGlobalF(file, effectiveRoot);
  if (!tagEntries.length) return undefined;

  const lines = await getFileLinesAsync(file, lineCache);
  // 正規化パスも lineCache に登録してキャッシュヒット率を向上させる
  if (norm !== file && !lineCache.has(norm)) lineCache.set(norm, lines);
  const funcEntries: { name: string; line: number }[] = [];
  for (const { name, line } of tagEntries) {
    const sourceLine = lines[line - 1]?.trimEnd() ?? '';
    if (isLikelyFuncDef(sourceLine)) funcEntries.push({ name, line });
  }
  if (!funcEntries.length) return undefined;

  funcEntries.sort((a, b) => a.line - b.line);
  const list: ScopeEntry[] = funcEntries.map((e, i) => ({
    name:  e.name,
    start: e.line,
    end:   i + 1 < funcEntries.length ? funcEntries[i + 1].line - 1 : Number.MAX_SAFE_INTEGER,
  }));
  const byName = new Map<string, ScopeEntry>();
  for (const s of list) {
    if (!byName.has(s.name)) byName.set(s.name, s); // 先勝ち (行番号が小さい定義を優先)
  }
  const entry: ScopeMapEntry = { list, byName };
  // 正規化・非正規化の両キーで登録してヒット率を上げる
  scopeCache.set(norm, entry);
  scopeCache.set(file, entry);
  touchScopeMap(scopeCache);
  return entry;
}


export async function buildFileCallGraphGtags(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0      = Date.now();
  const errs:   string[] = [];
  const wsRoot  = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) throw new Error('No workspace folder is open.');
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }
  pct.to(5);
  pct.report('📂 Loading tags...');
  const { tags, lineCache, scopeMap, droppedRefCount } = await collectGtagsCached(wsRoot);
  if (!tags.size) throw noTagsFoundError('No tags found.\nPlease verify that gtags is installed and GTAGS exists.', errs);
  if (droppedRefCount > 0) errs.push(
    `[gtags] Skipped ${droppedRefCount} reference(s) whose file path could not be resolved ` +
    '(a common cause: a folder name containing a space is not supported by gtags parsing).');
  const uncertain: UncertainResolution[] = [];

  const currentFile     = document.uri.fsPath;
  const currentFileNorm = normalizeFsPath(currentFile);
  // B5修正: GTAGSの行番号はディスク上の(保存済みの)内容を基準にしている。
  // 未保存のバッファ内容(document.getText())をそのまま使うと、保存前に行の追加/削除が
  // あった場合に行番号がズレて関数本体の抽出位置が合わなくなり、呼び出しの取りこぼし/
  // 誤検出につながる。GTAGSと常に整合するよう、常にディスクの内容を読む。
  const currentLines    = await getFileLinesAsync(currentFile, lineCache);
  lineCache.set(currentFileNorm, currentLines);
  if (document.isDirty) errs.push(
    '[gtags] This file has unsaved changes; the analysis reflects the last saved version on disk.');

  const fileScopes = findScopeMapEntry(scopeMap, currentFile)?.list ?? [];
  const nodes      = new Map<string, GraphNode>();
  for (const scope of fileScopes) {
    const entry = tags.get(scope.name)?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
    if (!entry) continue;
    const nodeId = makeGtagsNodeId(entry.file, scope.name, entry.line);
    nodes.set(nodeId, gtagsEntryToNode(scope.name, entry, scope, currentFile));
  }
  if (!nodes.size) throw new Error('No functions found in this file.');

  // global -rx でエッジ構築
  pct.to(20);
  checkCancellation(token);
  // callerFiles は normalizeFsPath 済みパスのみ格納し、
  // buildEdgesGlobalRx 側の has() 比較と形式を統一する。
  const callerFiles = new Set<string>([currentFileNorm]);
  for (const scope of fileScopes) {
    const e = tags.get(scope.name)?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
    if (e) callerFiles.add(normalizeFsPath(e.file));
  }
  const edgeSet = await buildEdgesGlobalRx(callerFiles, tags, scopeMap, wsRoot, token, pct, 20, 75, errs, wsRoots, uncertain);

  // edgeSet の callee ノードを登録
  for (const edgeKey of edgeSet) {
    const calleeId = edgeKey.split('|||')[1];
    if (nodes.has(calleeId)) continue;
    const { file: cf, name: cn } = parseGtagsNodeId(calleeId);
    const ce = tags.get(cn)?.find(e => e.file === cf && e.isFunc);
    if (!ce) continue;
    const cs = resolveCalleeScope(scopeMap, cf, cn, ce.line);
    if (cs) nodes.set(calleeId, gtagsEntryToNode(cn, ce, cs, currentFile));
  }

  // 下方向 BFS (全ノードを起点に再帰展開)
  pct.to(75);
  const downStartItems: Array<{ name: string; entry: GtagEntry; scope: ScopeEntry }> = [];
  for (const nodeId of nodes.keys()) {
    const { file: nf, name: nn } = parseGtagsNodeId(nodeId);
    const e = tags.get(nn)?.find(e => e.file === nf && e.isFunc);
    if (!e) continue;
    const s = resolveCalleeScope(scopeMap, nf, nn, e.line);
    if (s) downStartItems.push({ name: nn, entry: e, scope: s });
  }
  await gtagsBfsDownFull({ nodes, edgeSet, errs, uncertain, tags, scopeMap, lineCache, wsRoot, currentFile, startItems: downStartItems, token, pct, pctRange: [75, 88] });

  // 上方向 BFS (コアノードを起点に遡る)
  pct.to(88);
  const upStartItems = fileScopes.flatMap(scope => {
    const entry = tags.get(scope.name)?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
    return entry ? [{ funcName: scope.name, calleeId: makeGtagsNodeId(entry.file, scope.name, entry.line) }] : [];
  });
  // B: このコマンドは tags/scopeMap が collectGtagsCached(wsRoot) 由来の単一root分しか
  // 無いため、wsRoots(開いている全root)をそのまま渡すと他root分の global -rx が
  // 実行されても scopeMap に無く必ず捨てられる無駄な呼び出しになる。単一rootに絞る。
  await gtagsBfsUpFull({ nodes, edgeSet, errs, uncertain, tags, scopeMap, wsRoot, wsRoots: [wsRoot], currentFile, startItems: upStartItems, token, pct, pctRange: [88, 100] });
  errs.push(...formatUncertainResolutions(uncertain));

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: path.basename(currentFile), buildTimeMs: Date.now() - t0, errors: errs,
  };
}

export async function buildFunctionCallGraphGtags(
  document: vscode.TextDocument, position: vscode.Position, maxHops: number | undefined,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0    = Date.now();
  const errs: string[] = [];
  const wsRoot = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) throw new Error('No workspace folder is open.');
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }

  // モジュールレベルキャッシュを取得 (TTL 内なら前回ビルドを再利用)
  const now = Date.now();
  let lazyTagEntry = cache.getLazyTagEntry(wsRoot);
  if (!lazyTagEntry) { lazyTagEntry = { entries: new Map(), timestamp: now }; cache.setLazyTagEntry(wsRoot, lazyTagEntry); }
  const tagCache = lazyTagEntry.entries;
  let lazyScopeEntry = cache.getLazyScopeEntry(wsRoot);
  if (!lazyScopeEntry) { lazyScopeEntry = { scopes: new Map(), timestamp: now }; cache.setLazyScopeEntry(wsRoot, lazyScopeEntry); }
  const scopeCache = lazyScopeEntry.scopes;
  const lineCache: Map<string, string[]> = new Map();

  const currentFile     = document.uri.fsPath;
  const currentFileNorm = normalizeFsPath(currentFile);
  // B5修正: GTAGSの行番号はディスク上の(保存済みの)内容を基準にしている。
  // 未保存のバッファ内容(document.getText())をそのまま使うと、保存前に行の追加/削除が
  // あった場合に行番号がズレて関数本体の抽出位置が合わなくなり、呼び出しの取りこぼし/
  // 誤検出につながる。GTAGSと常に整合するよう、常にディスクの内容を読む。
  const currentLines    = await getFileLinesAsync(currentFile, lineCache);
  lineCache.set(currentFileNorm, currentLines);
  if (document.isDirty) errs.push(
    '[gtags] This file has unsaved changes; the analysis reflects the last saved version on disk.');

  // 起点関数を特定 (遅延ローディング)
  pct.to(5);
  checkCancellation(token);
  pct.report('🔍 Finding start function...');
  const startFileScopeEntry = await buildScopeForFileCached(currentFile, wsRoot, scopeCache, lineCache);
  if (!startFileScopeEntry?.list.length) throw new Error('No functions found in this file.');
  const startScope = findScopeAtLine(startFileScopeEntry.list, position.line + 1);
  if (!startScope) throw new Error('No function found at cursor position.\nPlace the cursor on a function name and try again.');
  const startCandidates = await resolveOrFetchTag(startScope.name, wsRoot, tagCache, errs);
  const startEntry =
    startCandidates?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc)
    ?? startCandidates?.find(e => e.isFunc)
    ?? startCandidates?.[0];
  if (!startEntry) throw new Error('Tag info for the start function was not found.');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();
  const uncertain: UncertainResolution[] = [];

  // 下方向 BFS のみ (遅延ローディング版)
  // LSP バックエンドの buildFunctionCallGraphLsp と挙動を統一する。
  // 双方向グラフが必要な場合は buildPathThroughCallGraphGtags を使用すること。
  pct.to(15);
  pct.report('⬇ Building callee graph...');
  await gtagsBfsDownLazy({ nodes, edgeSet, errs, uncertain, startEntry: { name: startScope.name, entry: startEntry, scope: startScope }, tagCache, scopeCache, lineCache, wsRoot, wsRoots, currentFile, maxHops, token, pct, pctRange: [15, 100] });
  errs.push(...formatUncertainResolutions(uncertain));

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: `${startScope.name} (${path.basename(currentFile)})`,
    buildTimeMs: Date.now() - t0, errors: errs,
  };
}

/** ルートごとに tags / scopeMap / nodes を収集してマージする。buildWorkspaceCallGraphGtags 専用。 */
async function collectWsTagsAndNodes(
  rootList: [string, vscode.Uri[]][],
  errs:     string[],
  pct:      Pct,
  token?:   vscode.CancellationToken,
): Promise<{ mergedTags: Map<string, GtagEntry[]>; mergedScopeMap: Map<string, ScopeMapEntry>; nodes: Map<string, GraphNode> }> {
  const mergedTags     = new Map<string, GtagEntry[]>();
  const mergedScopeMap = new Map<string, ScopeMapEntry>();
  const nodes          = new Map<string, GraphNode>();
  for (let ri = 0; ri < rootList.length; ri++) {
    const [wsRoot, rootUris] = rootList[ri];
    checkCancellation(token);
    pct.range(0, 20, ri, rootList.length);
    { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }
    let rootTags: Map<string, GtagEntry[]>, rootScopeMap: Map<string, ScopeMapEntry>;
    try {
      const r = await collectGtagsCached(wsRoot);
      rootTags = r.tags; rootScopeMap = r.scopeMap;
      if (r.droppedRefCount > 0) errs.push(
        `[gtags] Skipped ${r.droppedRefCount} reference(s) in ${path.basename(wsRoot)} whose file path ` +
        'could not be resolved (a common cause: a folder name containing a space is not supported by gtags parsing).');
    } catch (e) { errs.push(`[gtags] Failed to collect tags for ${wsRoot}: ${e}`); continue; }
    if (!rootTags.size) { errs.push(`[gtags] No tags found in ${wsRoot}. Run \`gtags\` in that folder.`); continue; }
    for (const [name, entries] of rootTags) {
      if (!mergedTags.has(name)) mergedTags.set(name, []);
      mergedTags.get(name)!.push(...entries);
    }
    for (const [fp, entry] of rootScopeMap) mergedScopeMap.set(fp, entry);
    touchScopeMap(mergedScopeMap);
    for (const uri of rootUris) {
      for (const scope of findScopeMapEntry(mergedScopeMap, uri.fsPath)?.list ?? []) {
        const entry = rootTags.get(scope.name)?.find(e => normalizeFsPath(e.file) === normalizeFsPath(uri.fsPath) && e.isFunc);
        if (!entry) continue;
        const nodeId = makeGtagsNodeId(entry.file, scope.name, entry.line);
        if (!nodes.has(nodeId)) nodes.set(nodeId, gtagsEntryToNode(scope.name, entry, scope, ''));
      }
    }
  }
  return { mergedTags, mergedScopeMap, nodes };
}

export async function buildWorkspaceCallGraphGtags(
  uris:      vscode.Uri[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0   = Date.now();
  const errs: string[] = [];
  const uniqueUris = Array.from(new Map(uris.map(u => [u.fsPath, u])).values())
    .filter(u => CC_SOURCE_EXTENSIONS.has(path.extname(u.fsPath).toLowerCase()));
  if (!uniqueUris.length) throw new Error('No C/C++ source files found.');

  const rootGroups = new Map<string, vscode.Uri[]>();
  let outsideWorkspaceCount = 0;
  for (const uri of uniqueUris) {
    // N6修正: getWorkspaceRootForFile はワークスペース未オープン時にファイルの
    // 親ディレクトリへフォールバックするが、ワークスペースが開かれている場合でも
    // 「対象ファイルがどのワークスペースフォルダにも属さない」ケースでは、
    // 無関係な最初のワークスペースフォルダへ誤って割り当ててしまう
    // (gtagsのDBが実際には存在しない場所に作られ、「No tags found」という
    //  的外れなエラーになる)。vscode.workspace.getWorkspaceFolder で
    // 実際にそのファイルを含むワークスペースフォルダかどうかを確認する。
    if (!vscode.workspace.getWorkspaceFolder(uri)) { outsideWorkspaceCount++; continue; }
    const root = getWorkspaceRootForFile(uri);
    if (!root) continue;
    if (!rootGroups.has(root)) rootGroups.set(root, []);
    rootGroups.get(root)!.push(uri);
  }
  if (!rootGroups.size) {
    if (outsideWorkspaceCount > 0) {
      throw new Error(
        `None of the ${outsideWorkspaceCount} selected file(s) are inside an open workspace folder.\n` +
        'gtags needs the analyzed files to be within a workspace folder ' +
        '(File > Open Folder...), not just referenced from elsewhere.');
    }
    throw new Error('No workspace folder is open.');
  }

  const pct      = new Pct(progress);
  const rootList = Array.from(rootGroups.entries());
  pct.to(0); checkCancellation(token);

  const { mergedTags, mergedScopeMap, nodes } = await collectWsTagsAndNodes(rootList, errs, pct, token);
  if (!mergedTags.size) throw noTagsFoundError('No tags found. Run `gtags` in each workspace root.', errs);

  // ルートごとに global -rx でエッジ構築
  const edgeSet     = new Set<string>();
  const allWsRoots  = rootList.map(([root]) => root);
  const uncertain: UncertainResolution[] = [];
  pct.to(20);
  checkCancellation(token);
  for (let ri = 0; ri < rootList.length; ri++) {
    const [wsRoot, rootUris] = rootList[ri];
    checkCancellation(token);
    // buildEdgesGlobalRx 側で normalizeFsPath(refFile) と比較するため、
    // callerFiles も normalizeFsPath 済みパスのみ格納して形式を統一する。
    const rootCallerFiles = new Set<string>();
    for (const uri of rootUris) { rootCallerFiles.add(normalizeFsPath(uri.fsPath)); }
    const rootEdges = await buildEdgesGlobalRx(rootCallerFiles, mergedTags, mergedScopeMap, wsRoot, token, pct,
      20 + Math.floor(ri * 70 / rootList.length), 20 + Math.floor((ri + 1) * 70 / rootList.length), errs, allWsRoots, uncertain);
    for (const e of rootEdges) edgeSet.add(e);
  }

  // edgeSet の callee ノードを登録
  for (const edgeKey of edgeSet) {
    const calleeId = edgeKey.split('|||')[1];
    if (nodes.has(calleeId)) continue;
    const { file: cf, name: cn } = parseGtagsNodeId(calleeId);
    const ce = mergedTags.get(cn)?.find(e => e.file === cf && e.isFunc);
    if (!ce) continue;
    const cs = resolveCalleeScope(mergedScopeMap, cf, cn, ce.line);
    if (cs) nodes.set(calleeId, gtagsEntryToNode(cn, ce, cs, ''));
  }

  // 下方向 BFS (全ノードを起点に再帰展開)
  pct.to(90);
  const bfsLineCache = new Map<string, string[]>();
  const downStartItems: Array<{ name: string; entry: GtagEntry; scope: ScopeEntry }> = [];
  for (const nodeId of nodes.keys()) {
    const { file: nf, name: nn } = parseGtagsNodeId(nodeId);
    const e = mergedTags.get(nn)?.find(e => e.file === nf && e.isFunc);
    if (!e) continue;
    const s = resolveCalleeScope(mergedScopeMap, nf, nn, e.line);
    if (s) downStartItems.push({ name: nn, entry: e, scope: s });
  }
  await gtagsBfsDownFull({ nodes, edgeSet, errs, uncertain, tags: mergedTags, scopeMap: mergedScopeMap, lineCache: bfsLineCache, wsRoot: rootList[0][0], currentFile: '', startItems: downStartItems, token, pct, pctRange: [90, 95] });

  // 上方向 BFS: 全登録ノードを起点として caller 方向を遡り上方向エッジを収集する。
  pct.to(95);
  const allWsRootsForUp = rootList.map(([r]) => r);
  const upStartItems: Array<{ funcName: string; calleeId: string }> = [];
  for (const nodeId of nodes.keys()) {
    const { name: nn } = parseGtagsNodeId(nodeId);
    upStartItems.push({ funcName: nn, calleeId: nodeId });
  }
  await gtagsBfsUpFull({ nodes, edgeSet, errs, uncertain, tags: mergedTags, scopeMap: mergedScopeMap, wsRoot: rootList[0][0], wsRoots: allWsRootsForUp, currentFile: '', startItems: upStartItems, token, pct, pctRange: [95, 100] });
  errs.push(...formatUncertainResolutions(uncertain));

  const label = uniqueUris.length === 1 ? path.basename(uniqueUris[0].fsPath) : `${uniqueUris.length} files`;
  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: label, buildTimeMs: Date.now() - t0, errors: errs,
  };
}

export async function buildPathThroughCallGraphGtags(
  document: vscode.TextDocument, position: vscode.Position, maxHops: number | undefined,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0    = Date.now();
  const errs: string[] = [];
  const wsRoot  = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) throw new Error('No workspace folder is open.');
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }
  pct.to(5);
  pct.report('📂 Loading tags...');
  const { tags, lineCache, scopeMap, droppedRefCount } = await collectGtagsCached(wsRoot);
  if (!tags.size) throw noTagsFoundError('No tags found.', errs);
  if (droppedRefCount > 0) errs.push(
    `[gtags] Skipped ${droppedRefCount} reference(s) whose file path could not be resolved ` +
    '(a common cause: a folder name containing a space is not supported by gtags parsing).');
  const uncertain: UncertainResolution[] = [];

  const currentFile     = document.uri.fsPath;
  const currentFileNorm = normalizeFsPath(currentFile);
  // B5修正: GTAGSの行番号はディスク上の(保存済みの)内容を基準にしている。
  // 未保存のバッファ内容(document.getText())をそのまま使うと、保存前に行の追加/削除が
  // あった場合に行番号がズレて関数本体の抽出位置が合わなくなり、呼び出しの取りこぼし/
  // 誤検出につながる。GTAGSと常に整合するよう、常にディスクの内容を読む。
  const currentLines    = await getFileLinesAsync(currentFile, lineCache);
  lineCache.set(currentFileNorm, currentLines);
  if (document.isDirty) errs.push(
    '[gtags] This file has unsaved changes; the analysis reflects the last saved version on disk.');

  // 起点関数を特定
  const cursorLine = position.line + 1;
  const fileScopes = findScopeMapEntry(scopeMap, currentFile)?.list ?? [];
  const startScope = findScopeAtLine(fileScopes, cursorLine);
  if (!startScope) throw new Error('No function found at cursor position.\nPlace the cursor on a function name and try again.');
  const startEntry =
    tags.get(startScope.name)?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc)
    ?? tags.get(startScope.name)?.find(e => e.isFunc)
    ?? tags.get(startScope.name)?.[0];
  if (!startEntry) throw new Error('Tag info for the start function was not found.');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  // 下方向 BFS
  pct.to(20);
  await gtagsBfsDownFull({ nodes, edgeSet, errs, uncertain, tags, scopeMap, lineCache, wsRoot, currentFile,
    startItems: [{ name: startScope.name, entry: startEntry, scope: startScope }],
    maxHops, token, pct, pctRange: [20, 55] });

  // 上方向 BFS
  pct.to(55);
  const startNodeId = makeGtagsNodeId(startEntry.file, startScope.name, startEntry.line);
  // B: このコマンドも tags/scopeMap が単一root分しか無いため wsRoots を [wsRoot] に絞る
  // (理由は buildFileCallGraphGtags と同様)。
  await gtagsBfsUpFull({ nodes, edgeSet, errs, uncertain, tags, scopeMap, wsRoot, wsRoots: [wsRoot], currentFile,
    startItems: [{ funcName: startScope.name, calleeId: startNodeId }],
    maxHops, token, pct, pctRange: [55, 100] });
  errs.push(...formatUncertainResolutions(uncertain));

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: `↕ ${startScope.name} (${path.basename(currentFile)})`,
    buildTimeMs: Date.now() - t0, errors: errs,
  };
}