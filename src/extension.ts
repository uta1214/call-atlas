/**
 * extension.ts
 *
 * 【変更点 (main ← gtags マージ)】
 *  - pickBackend() を追加: 実行のたびに LSP / gtags をユーザーが選択する
 *  - backend は build コールバックのクロージャで渡すため buildAndOutput の引数には含めない
 *
 * 【追加修正】
 *  - buildAndOutput: cancellable: true に変更し、token を build コールバックに渡す。(④)
 *    CancellationError はユーザー操作によるキャンセルのためエラーメッセージを表示しない。
 *  - deactivate(): CallGraphPanel.currentPanel?.dispose() を呼ぶ。(⑨)
 *    static パネルを context.subscriptions に追加できないため、
 *    deactivate 時に明示的に解放する。
 *
 * 【Feature G】callgraph.showFolderGraph コマンドを追加。
 *  - フォルダを選択してそのフォルダ配下のファイルのみを対象に解析する。
 *  - explorer/context のフォルダ右クリックから URI を直接受け取ることも可能。
 *  - vscode.RelativePattern でフォルダ相対のファイル検索を実現。
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { CallGraphPanel } from './webviewPanel';
import {
  buildFileCallGraph,
  buildFunctionCallGraph,
  buildWorkspaceCallGraph,
  buildPathThroughCallGraph,
  warmupCache,
  Backend,
  GraphData,
} from './callGraphBuilder';
import { cache } from './cacheManager';
import { hasCppSourceExtension, EXCLUDE_DIRS } from './utils';
/** ⑩ callatlas.warnThreshold 設定値を読み取る。設定変更時も都度参照するため関数化する。 */
function getWarnThreshold(): number {
  return vscode.workspace.getConfiguration('callatlas').get<number>('warnThreshold', 30);
}

type OutputMode = 'webview' | 'html';

// ─────────────────────────────────────────────────────────────────────────────
// 進捗表示 / キャンセル (ステータスバー方式)
//
// 以前は vscode.window.withProgress({ location: Notification, cancellable: true })
// によるポップアップ通知でキャンセルボタンを出していたが、ポップアップが目障りという
// フィードバックを受けてステータスバーに変更する。
// VS Code の仕様上、ProgressLocation.Window(ステータスバー)は withProgress 自体には
// キャンセルボタンを表示できない(Notification のみ対応)ため、withProgress は使わず
// StatusBarItem を自前で管理し、ホバー時のツールチップ(Markdown)内にコマンドリンクとして
// キャンセル操作を埋め込む。
// ─────────────────────────────────────────────────────────────────────────────

interface ActiveBuild {
  id:      number;
  label:   string; // 表示用ラベル(対象ファイル名/フォルダ名など)
  mode:    OutputMode;
  cts:     vscode.CancellationTokenSource;
  percent: number;
  message?: string;
}

let nextBuildId = 1;
const activeBuilds = new Map<number, ActiveBuild>();
let buildStatusBarItem: vscode.StatusBarItem | undefined;

/**
 * 現在 webview パネルを「担当」しているビルドの id。
 * コマンドの多重実行対策: CallGraphPanel はシングルトンのため、複数のビルドが
 * 同時に同じパネルへ書き込もうとすると「後から完了した方」が問答無用で
 * 先に完了した方の結果を上書きしてしまう。新しいビルドがパネルを使う際は、
 * 前の担当ビルドをキャンセルしてから自分を新しい担当者として記録する。
 */
let panelBuildOwner: number | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// 再生成 (Regenerate)
//
// ビルドが成功するたびに直近の1件だけを RegenerateHandle として覚えておき、
// ビルド中でない間はステータスバーの同じ場所を「再生成」表示に切り替える。
// 表示を消すタイミング: webview パネルが開いている間はずっと表示し、
// 閉じてから10秒後(あるいは html書き出しモードは完了から10秒後)に自動で消す。
// generation は「このタイマーが有効な間に、より新しい再生成対象で上書きされていないか」を
// 判定するためのもの(古いタイマーが新しい表示を誤って消さないようにする)。
// ─────────────────────────────────────────────────────────────────────────────

const REGENERATE_LINGER_MS = 10_000;

interface RegenerateHandle {
  generation: number;
  label:      string;
  /** callatlas.regenerateMode = "repeat": 直前と全く同じ設定で即再実行 */
  repeat:     () => Promise<void>;
  /** callatlas.regenerateMode = "reselect": 対象は固定のまま backend/mode 等を選び直す */
  reselect:   () => Promise<void>;
}

let lastRegenerate: RegenerateHandle | undefined;
let regenerateCloseSub: vscode.Disposable | undefined;
let regenerateExpireTimer: ReturnType<typeof setTimeout> | undefined;
let nextRegenGeneration = 1;

function clearRegenerateTracking(): void {
  regenerateCloseSub?.dispose();
  regenerateCloseSub = undefined;
  if (regenerateExpireTimer) clearTimeout(regenerateExpireTimer);
  regenerateExpireTimer = undefined;
}

/**
 * ビルド成功後に呼ぶ。直近の再生成対象として登録し、ステータスバーを更新する。
 * panel が渡された場合(webviewモード)は、そのパネルが閉じられてから
 * REGENERATE_LINGER_MS 後に表示を消す。panel が無い場合(htmlモード)は
 * 完了直後から同じ秒数のタイマーを開始する。
 */
function setLastRegenerate(
  label:   string,
  repeat:  () => Promise<void>,
  reselect: () => Promise<void>,
  panel:   CallGraphPanel | undefined,
): void {
  clearRegenerateTracking();
  const generation = nextRegenGeneration++;
  lastRegenerate = { generation, label, repeat, reselect };
  refreshBuildStatusBar();

  const startExpireTimer = (): void => {
    regenerateExpireTimer = setTimeout(() => {
      if (lastRegenerate?.generation === generation) {
        lastRegenerate = undefined;
        refreshBuildStatusBar();
      }
    }, REGENERATE_LINGER_MS);
  };

  if (panel) {
    regenerateCloseSub = panel.onDidClose(() => startExpireTimer());
  } else {
    startExpireTimer();
  }
}

/** activeBuilds の内容から StatusBarItem の text/tooltip を再構築して表示する。 */
function refreshBuildStatusBar(): void {
  if (!buildStatusBarItem) return;

  if (activeBuilds.size === 0) {
    if (!lastRegenerate) { buildStatusBarItem.hide(); return; }
    const r = lastRegenerate;
    // バー本体は常に固定表示にし、対象名はツールチップ側にのみ出す(省スペース化)。
    buildStatusBarItem.text = '$(refresh) Call Atlas';
    const md = new vscode.MarkdownString(
      `**Call Atlas** — last analyzed \`${r.label}\`\n\n` +
      `[$(refresh) Regenerate](command:callatlas.regenerate)`
    );
    md.isTrusted = { enabledCommands: ['callatlas.regenerate'] };
    md.supportThemeIcons = true;
    buildStatusBarItem.tooltip = md;
    buildStatusBarItem.show();
    return;
  }

  const cancelLink = (id: number): string =>
    `[$(stop) Cancel](command:callatlas.cancelBuild?${encodeURIComponent(JSON.stringify([id]))})`;

  if (activeBuilds.size === 1) {
    const b = [...activeBuilds.values()][0];
    const pct = Math.round(b.percent);
    // バー本体は進捗%のみ残し、対象名はツールチップ側にのみ出す(省スペース化)。
    buildStatusBarItem.text = `$(sync~spin) Call Atlas ${pct}%`;
    const md = new vscode.MarkdownString(
      `**Call Atlas** — building \`${b.label}\` (${pct}%)` +
      (b.message ? `\n\n${b.message}` : '') +
      `\n\n${cancelLink(b.id)}`
    );
    md.isTrusted = { enabledCommands: ['callatlas.cancelBuild'] };
    md.supportThemeIcons = true;
    buildStatusBarItem.tooltip = md;
  } else {
    // バー本体は件数ではなく全ビルドの平均進捗%のみ表示する(省スペース化)。
    // 件数・個別進捗の内訳はツールチップ側にのみ出す。
    const avgPct = Math.round(
      [...activeBuilds.values()].reduce((sum, b) => sum + b.percent, 0) / activeBuilds.size
    );
    buildStatusBarItem.text = `$(sync~spin) Call Atlas ${avgPct}%`;
    const lines = [...activeBuilds.values()].map(b =>
      `- \`${b.label}\` (${Math.round(b.percent)}%) — ${cancelLink(b.id)}`);
    const md = new vscode.MarkdownString(
      `**Call Atlas** — ${activeBuilds.size} builds running\n\n${lines.join('\n\n')}`);
    md.isTrusted = { enabledCommands: ['callatlas.cancelBuild'] };
    md.supportThemeIcons = true;
    buildStatusBarItem.tooltip = md;
  }
  buildStatusBarItem.show();
}

/**
 * build() コールバックへ渡す vscode.Progress 互換オブジェクトを作る。
 * report({message, increment}) は Pct クラス(utils.ts)が呼ぶ形式(increment は累積への差分、
 * message は "NN%" 形式)にそのまま対応する。
 */
function makeStatusBarProgress(build: ActiveBuild): vscode.Progress<{ message?: string; increment?: number }> {
  return {
    report(value: { message?: string; increment?: number }): void {
      if (value.increment !== undefined) {
        build.percent = Math.min(100, Math.max(0, build.percent + value.increment));
      }
      if (value.message !== undefined) build.message = value.message;
      refreshBuildStatusBar();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// フォルダ再帰探索
// vscode.workspace.findFiles + RelativePattern はワークスペース外フォルダや
// 特定 VS Code バージョンで 0 件を返すことがあるため、
// vscode.workspace.fs.readDirectory による再帰探索で代替する。
// ─────────────────────────────────────────────────────────────────────────────

/** 除外するディレクトリ名 (utils.ts の EXCLUDE_DIRS を使用。EXCLUDE_GLOB という
 *  変数はこのファイルには存在しない ─ gtagsBackend.ts 側で EXCLUDE_DIRS から
 *  動的生成している別物なので混同しないこと) */
// Low-2 修正: CMake / Ninja / ccache 等が生成するディレクトリを追加。
//   これらに生成ファイル (.c/.cpp) が含まれると解析結果に混入する。
// EXCLUDE_DIRS は utils.ts に集約(gtagsBackend.ts の候補選択ロジックとも共有するため)

/**
 * folderUri 配下のファイルを再帰的に収集して extensions でフィルタする。
 * シンボリックリンクは無視（無限ループ防止）。
 */
// 同時に読み取るディレクトリ数の上限。
// 制限が無いと、サブディレクトリ数が非常に多い巨大モノレポで
// Promise.all(subdirs.map(walk)) が再帰的に無制限展開し、
// 同時に大量の fs.readDirectory が走って EMFILE(開きすぎ)を招くリスクがある。
// 他箇所の BATCH_SIZE(6) / FILE_PARALLEL(3) と同程度の桁数に揃える。
const DIR_WALK_PARALLEL = 8;

async function findFilesInFolder(
  folderUri:  vscode.Uri,
  extensions: Set<string>
): Promise<vscode.Uri[]> {
  const result: vscode.Uri[] = [];

  // シンプルなセマフォ: readDirectory の同時実行数だけを絞る。
  // ディレクトリ読み取り自体が終わったら即 release するので、
  // その後の再帰展開(subdirs.map(walk))はブロックしない。
  let active = 0;
  const waiters: Array<() => void> = [];
  async function acquire(): Promise<void> {
    if (active < DIR_WALK_PARALLEL) { active++; return; }
    await new Promise<void>(resolve => waiters.push(resolve));
    // release() 側で待機者ありのときは既に「席を渡し済み」(active は減らされていない)
    // なので、ここで active++ はしない。
  }
  function release(): void {
    // 待機者がいる場合は active を減らさず、そのまま次の待機者に席を渡す。
    // (修正前は active-- した直後に next() を同期呼び出ししていたが、
    //  次の acquire() 側の active++ は await から復帰した後の別マイクロタスクになるため、
    //  その1マイクロタスク分の間だけ別の acquire() が active < DIR_WALK_PARALLEL を
    //  満たしてしまい、想定より1つ多く並列実行される余地があった)
    const next = waiters.shift();
    if (next) { next(); return; }
    active--;
  }

  async function walk(uri: vscode.Uri): Promise<void> {
    let entries: [string, vscode.FileType][];
    await acquire();
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return; // 読み取り不可なディレクトリはスキップ
    } finally {
      release();
    }
    const subdirs: vscode.Uri[] = [];
    for (const [name, type] of entries) {
      // Bug-6 修正: vscode.FileType はビットフラグ。
      // シンボリックリンクのディレクトリは FileType.SymbolicLink(64)|Directory(2)=66 となり
      // 厳密等価 === では Directory(2) にマッチしない。ビットマスクで判定する。
      // シンボリックリンクは無限ループ防止のため意図的に除外する。
      const isSymlink = !!(type & vscode.FileType.SymbolicLink);
      if (!isSymlink && (type & vscode.FileType.Directory)) {
        if (EXCLUDE_DIRS.has(name)) continue;
        subdirs.push(vscode.Uri.joinPath(uri, name)); // ① 収集してから並列展開
      } else if (!isSymlink && (type & vscode.FileType.File)) {
        if (extensions.has(path.extname(name).toLowerCase())) {
          result.push(vscode.Uri.joinPath(uri, name));
        }
      }
      // SymbolicLink は無限ループ防止のため意図的にスキップ
    }
    await Promise.all(subdirs.map(walk)); // ① 並列展開(同時実行数は acquire/release で制限)
  }

  await walk(folderUri);
  return result;
}

// C: findFilesInFolder の結果キャッシュ (60 秒 TTL)
// showWorkspaceGraph / showFolderGraph は毎回 readDirectory 再帰走査を行っていたが、
// 大規模プロジェクトでは数百ms〜数秒かかる。2回目以降はキャッシュから即座に返す。
// FSW の onChanged でキャッシュをクリアするため、ファイル追加・削除も自動的に反映される。
// QUALITY-2 修正: TTL チェックは CacheManager.getFolderFiles() 内部に移管したため
// FOLDER_FILES_CACHE_TTL 定数と getFolderFilesEntry の呼び出しを削除。


async function findFilesInFolderCached(
  folderUri:  vscode.Uri,
  extensions: Set<string>,
): Promise<vscode.Uri[]> {
  // BUG-3 修正: Unix ではファイルパスに '|' を含めることができるため \\x00 (NUL) を使用する。
  // NUL はファイルパスに含まれない唯一の文字であるためキー衝突が起きない。
  const key = `${folderUri.fsPath}\x00${[...extensions].sort().join(',')}`;
  const hit = cache.getFolderFiles(key);
  if (hit) return hit;
  // レースコンディション対策: findFilesInFolder() (再帰的なディレクトリ走査、
  // 大規模プロジェクトでは数秒かかりうる) の実行中に invalidateFileList()
  // (ファイル作成/削除時) が発生していた場合、その完了後の結果を無条件で
  // 書き戻すと無効化が巻き戻ってしまう。gtagsBackend.ts の findFilesCached() と
  // 同じ生成カウンタ方式で塞ぐ。
  const genAtStart = cache.getGeneration();
  const uris = await findFilesInFolder(folderUri, extensions);
  if (cache.getGeneration() === genAtStart) cache.setFolderFiles(key, uris);
  return uris;
}

// ─────────────────────────────────────────────────────────────────────────────
// QuickPick: バックエンド選択
// ─────────────────────────────────────────────────────────────────────────────

async function pickBackend(): Promise<Backend | undefined> {
  // ⑩ callatlas.defaultBackend 設定値を反映する
  // 'lsp' または 'gtags' に設定されている場合は QuickPick をスキップして即返す。
  // defaultOutputMode と同じ設計。'ask'（デフォルト）なら毎回選択を促す。
  const defaultBackend = vscode.workspace.getConfiguration('callatlas').get<string>('defaultBackend', 'ask');
  if (defaultBackend === 'lsp')   return 'lsp';
  if (defaultBackend === 'gtags') return 'gtags';
  const items = [
    {
      label:       '$(search) LSP (High accuracy)',
      description: 'Uses clangd / C/C++ extension. Requires LSP index.',
      backend:     'lsp' as const,
    },
    {
      label:       '$(zap) gtags (Fast)',
      description: 'Uses GNU GLOBAL. No LSP required. Suitable for large projects.',
      backend:     'gtags' as const,
    },
  ];
  // C2修正: この時点で defaultBackend は必ず 'ask' である(直前の if で 'lsp'/'gtags'
  // は既に return 済みのため)。'ask' に一致する item は存在しないため、
  // 以前あった `qp.activeItems = items.filter(i => i.backend === defaultBackend)` は
  // 常に空配列になるdead codeだった(削除)。この分岐に到達する時点でプリセットすべき
  // 既定値は無いため、初期選択なしのままでよい。
  type BackendItem = typeof items[number];
  const qp = vscode.window.createQuickPick<BackendItem>();
  qp.items       = items;
  qp.placeholder = 'Select analysis backend';
  qp.title       = 'Call Atlas: Backend';
  return new Promise(resolve => {
    // BUG-2 修正: onDidAccept → qp.hide() の順で呼ぶと onDidHide も必ず発火し
    // resolve(undefined) が再実行される。accepted フラグで二重解決を防ぐ。
    let accepted = false;
    qp.onDidAccept(() => {
      accepted = true;
      resolve(qp.selectedItems[0]?.backend);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!accepted) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// QuickPick: 出力モード選択
// ─────────────────────────────────────────────────────────────────────────────

async function pickOutputMode(): Promise<OutputMode | undefined> {
  // ③ callatlas.defaultOutputMode が 'webview' or 'html' なら QuickPick をスキップ
  const defaultMode = vscode.workspace.getConfiguration('callatlas').get<string>('defaultOutputMode', 'ask');
  if (defaultMode === 'webview') return 'webview';
  if (defaultMode === 'html')    return 'html';

  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(callhierarchy-outgoing) Open in WebView',        mode: 'webview' as const },
      { label: '$(browser) Save as HTML and open in browser', mode: 'html'    as const },
    ],
    { placeHolder: 'Select output mode', title: 'Call Atlas: Output mode' }
  );
  return picked?.mode;
}

// ─────────────────────────────────────────────────────────────────────────────
// QuickPick: ファイル拡張子選択 (⑦ showWorkspaceGraph / showFolderGraph で共用)
// ─────────────────────────────────────────────────────────────────────────────

type ExtItem = vscode.QuickPickItem & { extensions: Set<string> };

async function pickExtensions(title: string): Promise<ExtItem | undefined> {
  return vscode.window.showQuickPick<ExtItem>(
    [
      {
        label:       '$(files) C / C++ (all source)',
        description: '.c .cpp .cc .cxx .cu .cuh',
        extensions:  new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh']),
      },
      {
        label:       '$(files) C + C++ (no CUDA)',
        description: '.c .cpp .cc .cxx',
        extensions:  new Set(['.c', '.cpp', '.cc', '.cxx']),
      },
      {
        label:       '$(file-code) C only',
        description: '.c',
        extensions:  new Set(['.c']),
      },
      {
        label:       '$(file-code) C++ only',
        description: '.cpp .cc .cxx',
        extensions:  new Set(['.cpp', '.cc', '.cxx']),
      },
    ],
    { placeHolder: 'Select file extensions to analyze', title }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ビルド & 出力
// ─────────────────────────────────────────────────────────────────────────────

/** GraphData.fileName ("funcName (file.c)" や "↕ funcName (file.c)") から
 *  ファイル名用の「対象名」(関数名だけ)を取り出す。
 *  Function Graph / Path-Through Graph のように、対象(関数名)がビルド完了後にしか
 *  分からないコマンドで、明示的な subject が渡されなかった場合のフォールバックに使う。 */
function deriveSubjectFromFileName(fileName: string): string {
  return fileName.replace(/^↕\s*/, '').replace(/\s*\([^)]*\)\s*$/, '');
}

async function buildAndOutput(
  mode:         OutputMode,
  fileName:     string,
  extensionUri: vscode.Uri,
  build: (
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token:    vscode.CancellationToken
  ) => Promise<GraphData>,
  // 保存ファイル名の組み立てに使う「方式」と「対象名」。
  // kind: コマンドの種類(常に呼び出し元で分かる)。
  // subject: 対象名。呼び出し元で分かる場合(file/workspace/folder)は渡し、
  //          ビルド後にしか分からない場合(func/path、対象は解決された関数名)は省略する
  //          → data.fileName から deriveSubjectFromFileName() で導出する。
  kind:    'file' | 'func' | 'path' | 'workspace' | 'folder',
  subject?: string,
): Promise<boolean> {
  // N?修正: コマンドの多重実行対策。
  // html モードはパネルを介さず各々が独立したファイルを出力するため「上書き」の実害は無いが、
  // 同時に何本も重い解析を走らせる無駄を避けるため、実行中の他の html 書き出しがあれば断る。
  if (mode === 'html' && [...activeBuilds.values()].some(b => b.mode === 'html')) {
    vscode.window.showErrorMessage(
      'Call Atlas: Another HTML export is already in progress. Please wait for it to finish.');
    return false;
  }

  const panel = mode === 'webview' ? CallGraphPanel.createOrShow(extensionUri) : undefined;
  panel?.setLoading(path.basename(fileName));

  // ポップアップ通知(withProgress + Notification)は使わず、ステータスバーで進捗・キャンセルを扱う。
  // キャンセルは (a) ステータスバーのツールチップからの明示操作、(b) webview パネルを
  // 閉じる操作、のどちらでも発火するよう1つの CancellationTokenSource に集約する。
  const cts   = new vscode.CancellationTokenSource();
  const abuild: ActiveBuild = { id: nextBuildId++, label: path.basename(fileName), mode, cts, percent: 0 };
  activeBuilds.set(abuild.id, abuild);

  // N?修正: webview モードは CallGraphPanel がシングルトンのため、複数のビルドが
  // 同時に同じパネルへ書き込もうとすると「後から完了した方」が問答無用で先に完了した方の
  // 結果を上書きしてしまう(例: 軽い関数グラフを見ている最中に誤ってワークスペース全体解析を
  // 実行すると、後で完了したワークスペース解析にいつの間にか差し替わる)。
  // 新しいビルドがこのパネルを使う際は、前の担当ビルドをキャンセルしてから
  // 自分を新しい担当者として記録する。万一キャンセルが間に合わず前のビルドが
  // 先に build() を抜けてしまっても、ownsPanel() で「自分が今も担当者か」を
  // 確認してからでないとパネルへは書き込まない(二重の安全策)。
  if (panel) {
    if (panelBuildOwner !== undefined) activeBuilds.get(panelBuildOwner)?.cts.cancel();
    panelBuildOwner = abuild.id;
  }
  const ownsPanel = (): boolean => !panel || panelBuildOwner === abuild.id;

  refreshBuildStatusBar();

  // webview パネルが閉じられたら、このビルドもキャンセルする。
  // (以前はパネルを閉じてもバックグラウンドで解析が最後まで走り続けていた)
  const closeSub = panel?.onDidClose(() => cts.cancel());

  try {
    const data = await build(makeStatusBarProgress(abuild), cts.token);

    // キャンセル済みの場合はパネルを更新しない。
    // A8修正: catch節のCancellationErrorパスと同様に showCancelled() を呼ぶ。
    // 呼ばないと setLoading() で出したスピナー表示が解除されないまま残ってしまう。
    if (cts.token.isCancellationRequested) { if (ownsPanel()) panel?.showCancelled(); return false; }

    data.kind    = kind;
    data.subject = subject ?? deriveSubjectFromFileName(data.fileName);

    if (data.errors.length > 0) console.warn('[CallAtlas] Analysis warnings:', data.errors);

    // A7修正: ノードが1件も無いまま webview/html を出すと、
    // 「壊れているのか、本当に0件なのか」がユーザーから分からない空白のグラフになる。
    // LSP未起動・未インデックスや、gtagsでワークスペース外を指定した場合などで発生しうる。
    if (data.nodes.length === 0) {
      const detail = data.errors.length > 0 ? `\n${data.errors.slice(0, 3).join('\n')}` : '';
      throw new Error(
        `No functions found in the analysis result.${detail}\n` +
        'Check that the language server (clangd/cpptools) is running and fully indexed, or that gtags is installed and GTAGS exists.');
    }

    if (mode === 'webview') {
      if (ownsPanel()) panel!.updateGraph(data);
    } else {
      await CallGraphPanel.exportHtmlFile(extensionUri, data);
    }
    return true;
  } catch (err) {
    // CancellationError はユーザー操作によるキャンセルのため通知はしないが、
    // webview パネルのローディング表示(デフォルト表示中)を放置すると
    // 「固まった」ように見えたままになるため、パネルへは状態を伝える
    // (自分がまだ担当者の場合のみ。supersedeされていれば何もしない)。
    if (err instanceof vscode.CancellationError) {
      if (ownsPanel()) panel?.showCancelled();
      return false;
    }

    const msg = err instanceof Error ? err.message : String(err);
    if (panel) { if (ownsPanel()) panel.showError(msg); }
    else vscode.window.showErrorMessage('Call Atlas error:\n' + msg);
    return false;
  } finally {
    closeSub?.dispose();
    cts.dispose();
    activeBuilds.delete(abuild.id);
    // 自分がまだ担当者だった場合のみクリアする。既に新しいビルドに
    // supersede されていた場合はそのビルドの担当権を誤って消さないよう触らない。
    if (panelBuildOwner === abuild.id) panelBuildOwner = undefined;
    refreshBuildStatusBar();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// コマンド登録
// ─────────────────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {

  // ── ビルド進捗/キャンセル用ステータスバーアイテム ──────────────────────────
  // ビルド中のみ表示する。ホバー時のツールチップ内のリンクからキャンセルできる。
  buildStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  buildStatusBarItem.name = 'Call Atlas: build progress';
  context.subscriptions.push(buildStatusBarItem);
  context.subscriptions.push(
    vscode.commands.registerCommand('callatlas.cancelBuild', (id?: number) => {
      if (id !== undefined) {
        activeBuilds.get(id)?.cts.cancel();
      } else {
        // 引数無しで呼ばれた場合(想定外の経路)は念のため全ビルドをキャンセルする
        activeBuilds.forEach(b => b.cts.cancel());
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('callatlas.regenerate', async () => {
      if (!lastRegenerate) return;
      const regenMode = vscode.workspace.getConfiguration('callatlas')
        .get<string>('regenerateMode', 'repeat');
      if (regenMode === 'reselect') await lastRegenerate.reselect();
      else await lastRegenerate.repeat();
    })
  );

  // ⑦ ファイル変更時にキャッシュを無効化する FileSystemWatcher
  // B15修正: 以前は utils.ts の CC_CALLEE_EXTENSIONS にある .hh/.inl/.ipp/.tpp/.tcc/.h++/.c++
  // が含まれておらず、これらの拡張子のファイルを変更してもキャッシュが無効化されなかった。
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{c,cpp,cc,cxx,cu,cuh,c++,h,hh,hpp,hxx,h++,inl,ipp,tpp,tcc}',
    false, false, false
  );
  // A: FileSystemWatcher デバウンス（バグ修正版）
  // ──────────────────────────────────────────────────────────────────────────
  // ① onDidChange（ファイル内容変更）: graphData / tags キャッシュのみ無効化。
  //    ファイル一覧は変わらないため invalidateFileList は呼ばない。
  // ② onDidCreate / onDidDelete（ファイル構造変更）: 全キャッシュ + fileList 系を無効化。
  //    デバウンスタイマーを分離することで、両イベントが混在しても確実に動作する。
  // SEC-05 修正: ウォッチャーグロブ '**' は node_modules / build 等を含む。
  //   VS Code の createFileSystemWatcher は exclude パターンをサポートしないため、
  //   イベントハンドラ内で EXCLUDE_DIRS を使って除外する。
  // ──────────────────────────────────────────────────────────────────────────

  // A4修正: 絶対パス全体のセグメントで判定すると、ワークスペース自体が
  // build/vendor/.cache 等のディレクトリ配下にある場合(Yocto/Buildroot等の
  // 組み込み開発でよくある構成)、その配下の全ファイルが除外されてしまっていた。
  // ワークスペースルートからの相対パスのセグメントだけを見るよう修正。
  // ワークスペース外のファイル(単一ファイルを開いているだけ等)は除外しない
  // (そもそも EXCLUDE_DIRS は「プロジェクト内の生成物ディレクトリ」を
  //  除外する意図であり、ワークスペース外ファイルの扱いを変えるものではない)。
  const isExcludedPath = (fsPath: string): boolean => {
    const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
    if (!wsFolder) return false;
    const rel = path.relative(wsFolder.uri.fsPath, fsPath);
    return rel.split(/[/\\]/).some(seg => EXCLUDE_DIRS.has(seg));
  };

  let _contentTimer: ReturnType<typeof setTimeout> | undefined;
  const _contentPending = new Set<string>();
  const onContentChanged = (uri: vscode.Uri) => {
    if (isExcludedPath(uri.fsPath)) return; // SEC-05 除外
    _contentPending.add(uri.fsPath);
    clearTimeout(_contentTimer);
    _contentTimer = setTimeout(() => {
      const paths = [..._contentPending];
      _contentPending.clear();
      if (paths.length >= 5) cache.invalidateAll();
      else paths.forEach(fp => cache.invalidateFile(fp));

    }, 300);
  };

  let _structTimer: ReturnType<typeof setTimeout> | undefined;
  const _structPending = new Set<string>();
  const onFsStructureChanged = (uri: vscode.Uri) => {
    if (isExcludedPath(uri.fsPath)) return; // SEC-05 除外
    _structPending.add(uri.fsPath);
    clearTimeout(_structTimer);
    _structTimer = setTimeout(() => {
      const paths = [..._structPending];
      _structPending.clear();
      if (paths.length >= 5) cache.invalidateAll();
      else {
        paths.forEach(fp => cache.invalidateFile(fp));
        cache.invalidateFileList(); // 構造変更時のみ fileList 系もクリア
      }
    }, 300);
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onContentChanged),
    watcher.onDidCreate(onFsStructureChanged),
    watcher.onDidDelete(onFsStructureChanged),
  );

  // ── ワークスペース横断解析 ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showWorkspaceGraph', async () => {
      // 再生成(repeat/reselect)でも使う共通ビルド処理。
      // ファイル検索は毎回やり直す(ファイル構成が変わっている可能性があるため)。
      const runBuild = async (ep: ExtItem, b: Backend, m: OutputMode): Promise<void> => {
        const wsFolders = vscode.workspace.workspaceFolders;
        if (!wsFolders?.length) {
          vscode.window.showErrorMessage('Call Atlas: No workspace folder is open.');
          return;
        }
        const foundUris = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Searching C/C++ files...', cancellable: false },
          async () => (await Promise.all(
            wsFolders.map(folder => findFilesInFolderCached(folder.uri, ep.extensions)))).flat()
        );
        if (!foundUris.length) {
          vscode.window.showErrorMessage('Call Atlas: No target files found.\nExtension: ' + ep.description);
          return;
        }
        if (foundUris.length > getWarnThreshold()) {
          const answer = await vscode.window.showWarningMessage(
            `Analyze ${foundUris.length} files. Continue?`, { modal: true }, 'Continue');
          if (answer !== 'Continue') return;
        }
        const activeEditor2 = vscode.window.activeTextEditor;
        await ((activeEditor2 && hasCppSourceExtension(activeEditor2.document.uri))
          ? warmupCache(activeEditor2.document, b).catch(() => {}) : Promise.resolve());
        const wsSubject = vscode.workspace.name
          ?? (path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') || 'workspace');
        const ok = await buildAndOutput(m, `${foundUris.length} files`, context.extensionUri,
          (prog, tok) => buildWorkspaceCallGraph(foundUris, b, prog, tok), 'workspace', wsSubject);
        if (ok) {
          setLastRegenerate(
            wsSubject,
            () => runBuild(ep, b, m),
            async () => {
              const ep2 = await pickExtensions('Call Atlas: Workspace analysis'); if (!ep2) return;
              const b2  = await pickBackend(); if (!b2) return;
              const m2  = await pickOutputMode(); if (!m2) return;
              await runBuild(ep2, b2, m2);
            },
            m === 'webview' ? CallGraphPanel.currentPanel : undefined,
          );
        }
      };

      // ★ Fix 2: showFolderGraph と同じ extensions Set ベースの QuickPick に統一
      //   glob ベースの vscode.workspace.findFiles → findFilesInFolder (fs.readDirectory) に変更。
      //   動作の一貫性を保ちつつ、RelativePattern の互換問題も回避する。
      const extPick = await pickExtensions('Call Atlas: Workspace analysis'); // ⑦ 共通化
      if (!extPick) return;

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        vscode.window.showErrorMessage('Call Atlas: No workspace folder is open.');
        return;
      }

      // ★ Fix 2: 全ワークスペースフォルダを findFilesInFolder で並列収集してフラット化
      const foundUris = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Searching C/C++ files...', cancellable: false },
        async () => {
          const results = await Promise.all(
            workspaceFolders.map(folder => findFilesInFolderCached(folder.uri, extPick.extensions))
          );
          return results.flat();
        }
      );
      if (!foundUris.length) {
        vscode.window.showErrorMessage(
          'Call Atlas: No target files found.\nExtension: ' + extPick.description);
        return;
      }

      if (foundUris.length > getWarnThreshold()) {
        const answer = await vscode.window.showWarningMessage(
          `Analyze ${foundUris.length} files. Continue?`, { modal: true }, 'Continue');
        if (answer !== 'Continue') return;
      }

      const backend = await pickBackend();
      if (!backend) return;
      // BUG-02 修正: showWorkspaceGraph でも backend 確定後に warmupCache を呼ぶ。
      // pickOutputMode の待機中に gtags DB 更新・タグキャッシュ温めを並行実行する。
      const activeEditor = vscode.window.activeTextEditor;
      // BUG-08 修正: 非 C/C++ ファイルを開いていると warmup が無意味になる（LSP は無関係なシンボルを取得）。
      const warmupDone = (activeEditor && hasCppSourceExtension(activeEditor.document.uri))
        ? warmupCache(activeEditor.document, backend).catch(() => {}) : Promise.resolve();
      const mode = await pickOutputMode();
      if (!mode) { await warmupDone; return; }
      await warmupDone;

      const wsSubject = vscode.workspace.name
        ?? (path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') || 'workspace');
      const ok = await buildAndOutput(mode, `${foundUris.length} files`, context.extensionUri,
        (prog, tok) => buildWorkspaceCallGraph(foundUris, backend, prog, tok), 'workspace', wsSubject);
      if (ok) {
        setLastRegenerate(
          wsSubject,
          () => runBuild(extPick, backend, mode),
          async () => {
            const ep2 = await pickExtensions('Call Atlas: Workspace analysis'); if (!ep2) return;
            const b2  = await pickBackend(); if (!b2) return;
            const m2  = await pickOutputMode(); if (!m2) return;
            await runBuild(ep2, b2, m2);
          },
          mode === 'webview' ? CallGraphPanel.currentPanel : undefined,
        );
      }
    })
  );

  // ── フォルダ指定コールグラフ ──────────────────────────────────────────────
  // explorer/context のフォルダ右クリックから呼ばれた場合は uri が渡される。
  // コマンドパレット / エディタ右クリックから呼ばれた場合は uri が undefined のため
  // showOpenDialog でフォルダを選択させる。
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showFolderGraph', async (uri?: vscode.Uri) => {
      let folderUri: vscode.Uri | undefined;

      if (uri) {
        // explorer/context（フォルダ右クリック）: フォルダ URI が渡される
        // editor/context（エディタ右クリック）: ファイル URI が渡されるため親ディレクトリを使う
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          // Bug-6 同様、FileType はビットフラグ。シンボリックリンクのディレクトリは
          // FileType.SymbolicLink(64)|Directory(2)=66 となるため厳密等価では判定できない。
          folderUri = (stat.type & vscode.FileType.Directory)
            ? uri
            : vscode.Uri.file(path.dirname(uri.fsPath));
        } catch {
          // stat 失敗時は親ディレクトリにフォールバック
          folderUri = vscode.Uri.file(path.dirname(uri.fsPath));
        }
      } else {
        // コマンドパレット / エディタ右クリック経由: ダイアログでフォルダを選択
        // デフォルト位置を現在のファイルのフォルダに設定する
        const activeFile = vscode.window.activeTextEditor?.document.uri;
        const defaultUri = activeFile
          ? vscode.Uri.file(path.dirname(activeFile.fsPath))
          : vscode.workspace.workspaceFolders?.[0]?.uri;
        const result = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles:   false,
          canSelectMany:    false,
          openLabel:        'Analyze this folder',
          title:            'Call Atlas: Select folder to analyze',
          defaultUri,
        });
        if (!result?.length) return;
        folderUri = result[0];
      }

      const extPick = await pickExtensions('Call Atlas: Folder analysis'); // ⑦ 共通化
      if (!extPick) return;
      if (!folderUri) return; // 型ガード (到達しないが TypeScript の安全のため)
      // R1修正: folderUri (let, Uri|undefined) はこの後のアロー関数(クロージャ)の中では
      // TypeScriptがnarrowingを保持できない(TS2345)。TypeScript 5.3時点でこの制約があり、
      // これは esbuild(型チェックしない)では気づけず、tsc --noEmit を compile に
      // 組み込んで初めて顕在化した。const に束縛することでクロージャ内でも
      // narrowing された型(Uri)のまま扱えるようにする。
      const targetFolder: vscode.Uri = folderUri;

      // 再生成(repeat/reselect)でも使う共通ビルド処理。フォルダは固定、拡張子/backend/modeは
      // repeatなら直前と同じ、reselectなら選び直す。ファイル検索は毎回やり直す。
      const runBuild = async (ep: ExtItem, b: Backend, m: OutputMode): Promise<void> => {
        const foundUris2 = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Searching C/C++ files...', cancellable: false },
          () => findFilesInFolderCached(targetFolder, ep.extensions)
        );
        if (!foundUris2.length) {
          vscode.window.showErrorMessage(
            `Call Atlas: No target files found.\nFolder: ${targetFolder.fsPath}\nExtension: ${ep.description}`);
          return;
        }
        if (foundUris2.length > getWarnThreshold()) {
          const answer = await vscode.window.showWarningMessage(
            `Analyze ${foundUris2.length} files. Continue?`, { modal: true }, 'Continue');
          if (answer !== 'Continue') return;
        }
        const activeEditor2 = vscode.window.activeTextEditor;
        await ((activeEditor2 && hasCppSourceExtension(activeEditor2.document.uri))
          ? warmupCache(activeEditor2.document, b).catch(() => {}) : Promise.resolve());
        const folderName2 = path.basename(targetFolder.fsPath);
        const ok = await buildAndOutput(m, folderName2, context.extensionUri,
          (prog, tok) => buildWorkspaceCallGraph(foundUris2, b, prog, tok), 'folder', folderName2);
        if (ok) {
          setLastRegenerate(
            folderName2,
            () => runBuild(ep, b, m),
            async () => {
              const ep2 = await pickExtensions('Call Atlas: Folder analysis'); if (!ep2) return;
              const b2  = await pickBackend(); if (!b2) return;
              const m2  = await pickOutputMode(); if (!m2) return;
              await runBuild(ep2, b2, m2);
            },
            m === 'webview' ? CallGraphPanel.currentPanel : undefined,
          );
        }
      };

      // vscode.workspace.fs.readDirectory による再帰探索
      // （RelativePattern + findFiles はワークスペース外フォルダで 0 件になる場合がある）
      const foundUris = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Searching C/C++ files...', cancellable: false },
        () => findFilesInFolderCached(targetFolder, extPick.extensions)
      );

      if (!foundUris.length) {
        vscode.window.showErrorMessage(
          `Call Atlas: No target files found.\nFolder: ${targetFolder.fsPath}\nExtension: ${extPick.description}`);
        return;
      }

      if (foundUris.length > getWarnThreshold()) {
        const answer = await vscode.window.showWarningMessage(
          `Analyze ${foundUris.length} files. Continue?`, { modal: true }, 'Continue');
        if (answer !== 'Continue') return;
      }

      const backend = await pickBackend();
      if (!backend) return;
      // BUG-02 修正: showFolderGraph でも warmupCache を並行実行する。
      const activeEditorF = vscode.window.activeTextEditor;
      // BUG-08 修正: 非 C/C++ ファイルを開いていると warmup が無意味になる。
      const warmupDoneF = (activeEditorF && hasCppSourceExtension(activeEditorF.document.uri))
        ? warmupCache(activeEditorF.document, backend).catch(() => {}) : Promise.resolve();
      const mode = await pickOutputMode();
      if (!mode) { await warmupDoneF; return; }
      await warmupDoneF;

      const folderName = path.basename(folderUri.fsPath);
      const ok = await buildAndOutput(mode, folderName, context.extensionUri,
        (prog, tok) => buildWorkspaceCallGraph(foundUris, backend, prog, tok), 'folder', folderName);
      if (ok) {
        setLastRegenerate(
          folderName,
          () => runBuild(extPick, backend, mode),
          async () => {
            const ep2 = await pickExtensions('Call Atlas: Folder analysis'); if (!ep2) return;
            const b2  = await pickBackend(); if (!b2) return;
            const m2  = await pickOutputMode(); if (!m2) return;
            await runBuild(ep2, b2, m2);
          },
          mode === 'webview' ? CallGraphPanel.currentPanel : undefined,
        );
      }
    })
  );

  // ── ファイル単位コールグラフ ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showFileGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Call Atlas: Please open a C/C++ file first.');
        return;
      }
      const uri = editor.document.uri;

      // 再生成(repeat/reselect)でも使う共通ビルド処理。
      // 対象は常に uri を openTextDocument し直して取得する
      // (パネルを閉じたまま時間を置いて再生成した場合でも、元のエディタが
      //  閉じられている可能性があるため、URI から都度ドキュメントを取り直す)。
      const runBuild = async (b: Backend, m: OutputMode): Promise<void> => {
        const document = await vscode.workspace.openTextDocument(uri);
        await warmupCache(document, b).catch(() => {});
        const ok = await buildAndOutput(m, document.fileName, context.extensionUri,
          (prog, tok) => buildFileCallGraph(document, b, prog, tok),
          'file', path.basename(document.fileName, path.extname(document.fileName)));
        if (ok) {
          setLastRegenerate(
            path.basename(document.fileName),
            () => runBuild(b, m),
            async () => {
              const b2 = await pickBackend(); if (!b2) return;
              const m2 = await pickOutputMode(); if (!m2) return;
              await runBuild(b2, m2);
            },
            m === 'webview' ? CallGraphPanel.currentPanel : undefined,
          );
        }
      };

      const backend = await pickBackend();
      if (!backend) return;
      // B: バックエンド確定直後に初期化を先行起動。pickOutputMode 待ちの間に走る。
      const warmupDone = warmupCache(editor.document, backend).catch(() => {});
      const mode = await pickOutputMode();
      if (!mode) { await warmupDone; return; } // キャンセル時も Promise を settle させる
      await warmupDone; // すでに完了していれば即座に返る

      const ok = await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        (prog, tok) => buildFileCallGraph(editor.document, backend, prog, tok),
        'file', path.basename(editor.document.fileName, path.extname(editor.document.fileName)));
      if (ok) {
        setLastRegenerate(
          path.basename(editor.document.fileName),
          () => runBuild(backend, mode),
          async () => {
            const b2 = await pickBackend(); if (!b2) return;
            const m2 = await pickOutputMode(); if (!m2) return;
            await runBuild(b2, m2);
          },
          mode === 'webview' ? CallGraphPanel.currentPanel : undefined,
        );
      }
    })
  );

  // ── 関数起点 BFS コールグラフ ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showFunctionGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Call Atlas: Please open a C/C++ file first.');
        return;
      }
      const uri      = editor.document.uri;
      const position = editor.selection.active;

      const runBuild = async (b: Backend, m: OutputMode): Promise<void> => {
        const document = await vscode.workspace.openTextDocument(uri);
        await warmupCache(document, b).catch(() => {});
        const ok = await buildAndOutput(m, document.fileName, context.extensionUri,
          (prog, tok) => {
            const maxHopsSetting = vscode.workspace.getConfiguration('callatlas').get<number>('maxHops', 0);
            const maxHops = maxHopsSetting > 0 ? maxHopsSetting : undefined;
            return buildFunctionCallGraph(document, position, maxHops, b, prog, tok);
          }, 'func');
        if (ok) {
          setLastRegenerate(
            path.basename(document.fileName),
            () => runBuild(b, m),
            async () => {
              const b2 = await pickBackend(); if (!b2) return;
              const m2 = await pickOutputMode(); if (!m2) return;
              await runBuild(b2, m2);
            },
            m === 'webview' ? CallGraphPanel.currentPanel : undefined,
          );
        }
      };

      const backend = await pickBackend();
      if (!backend) return;
      // B: バックエンド確定直後に初期化を先行起動
      const warmupDone = warmupCache(editor.document, backend).catch(() => {});
      const mode = await pickOutputMode();
      if (!mode) { await warmupDone; return; }
      await warmupDone;

      const ok = await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        // ⑩ callatlas.maxHops 設定値を参照する（デフォルト 0 = 無制限）。
        (prog, tok) => {
          const maxHopsSetting = vscode.workspace.getConfiguration('callatlas').get<number>('maxHops', 0);
          const maxHops = maxHopsSetting > 0 ? maxHopsSetting : undefined;
          return buildFunctionCallGraph(editor.document, position, maxHops, backend, prog, tok);
        }, 'func');
      if (ok) {
        setLastRegenerate(
          path.basename(editor.document.fileName),
          () => runBuild(backend, mode),
          async () => {
            const b2 = await pickBackend(); if (!b2) return;
            const m2 = await pickOutputMode(); if (!m2) return;
            await runBuild(b2, m2);
          },
          mode === 'webview' ? CallGraphPanel.currentPanel : undefined,
        );
      }
    })
  );

  // ── パス貫通コールグラフ ─────────────────────────────────────────────────
  // 選択した関数を中心に、上方向 (callers) + 下方向 (callees) を展開して
  // "F を通る" パスを表示する。LSP / gtags 両バックエンド対応。
  // コマンドパレット: Ctrl+Alt+P / 右クリックメニュー
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showPathGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Call Atlas: Please open a C/C++ file first.');
        return;
      }
      const uri      = editor.document.uri;
      const position = editor.selection.active;

      const runBuild = async (b: Backend, m: OutputMode): Promise<void> => {
        const document = await vscode.workspace.openTextDocument(uri);
        await warmupCache(document, b).catch(() => {});
        const maxHopsSetting = vscode.workspace.getConfiguration('callatlas').get<number>('maxHops', 0);
        const maxHops = maxHopsSetting > 0 ? maxHopsSetting : undefined;
        const ok = await buildAndOutput(m, document.fileName, context.extensionUri,
          (prog, tok) => buildPathThroughCallGraph(document, position, maxHops, b, prog, tok), 'path');
        if (ok) {
          setLastRegenerate(
            path.basename(document.fileName),
            () => runBuild(b, m),
            async () => {
              const b2 = await pickBackend(); if (!b2) return;
              const m2 = await pickOutputMode(); if (!m2) return;
              await runBuild(b2, m2);
            },
            m === 'webview' ? CallGraphPanel.currentPanel : undefined,
          );
        }
      };

      const backend = await pickBackend();
      if (!backend) return;
      // バックエンド選択後に warmup を先行起動（pickOutputMode 待ちの間に DB 更新が走る）
      const warmupDone = warmupCache(editor.document, backend).catch(() => {});
      const mode = await pickOutputMode();
      if (!mode) { await warmupDone; return; }
      await warmupDone;

      // ⑩ callatlas.maxHops 設定値を参照する（デフォルト 0 = 無制限）
      const maxHopsSetting = vscode.workspace.getConfiguration('callatlas').get<number>('maxHops', 0);
      const maxHops = maxHopsSetting > 0 ? maxHopsSetting : undefined;
      const ok = await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        (prog, tok) => buildPathThroughCallGraph(
          editor.document, position, maxHops, backend, prog, tok), 'path');
      if (ok) {
        setLastRegenerate(
          path.basename(editor.document.fileName),
          () => runBuild(backend, mode),
          async () => {
            const b2 = await pickBackend(); if (!b2) return;
            const m2 = await pickOutputMode(); if (!m2) return;
            await runBuild(b2, m2);
          },
          mode === 'webview' ? CallGraphPanel.currentPanel : undefined,
        );
      }
    })
  );
}

// ★ ⑨: 拡張機能の非アクティブ化時に static パネルを明示的に解放する。
//   CallGraphPanel.currentPanel は context.subscriptions に入らないため、
//   deactivate() で手動 dispose する必要がある。
export function deactivate(): void {
  activeBuilds.forEach(b => b.cts.cancel());
  clearRegenerateTracking();
  CallGraphPanel.currentPanel?.dispose();
  cache.invalidateAll();
}