/**
 * webviewPanel.ts  ─  WebView パネル管理
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import * as crypto from 'crypto';
import * as os     from 'os';
import { GraphData, MAX_SOURCE_LINES } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// パスセキュリティユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebView から渡されたファイルパスを安全に正規化する。
 *
 * path.normalize のみでは "../../etc/passwd" のような相対パスを
 * startsWith でのワークスペースチェックが弾けない場合がある。
 * path.resolve で絶対パスに変換した上で比較することで
 * ディレクトリトラバーサルを確実に防ぐ。
 *
 * シンボリックリンクパストラバーサル対策:
 *   path.resolve はシンボリックリンクを解決しないため、
 *   ワークスペース内のシンボリックリンク → ワークスペース外ファイル という経路が
 *   isPathInWorkspace のチェックを通過し、fs.readFile で実体ファイルを読まれる恐れがある。
 *   fs.realpathSync でシンボリックリンクを解決してから比較する。
 *   ファイルが存在しない場合は null を返してアクセスを拒否する。
 *
 * macOS / Windows では大文字小文字を統一するため toLowerCase() を適用する。
 */
function resolveAndNormalize(p: string): string | null {
  const resolved = path.resolve(p);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  return (process.platform === 'win32' || process.platform === 'darwin')
    ? real.toLowerCase() : real;
}

/**
 * filePath がワークスペースルートのいずれかの配下にあるか、
 * または現在表示中のグラフに実在するファイル（allowedFiles）かを検証する。
 *
 * allowedFiles は updateGraph() が data.nodes から都度構築する信頼できる許可リストであり、
 * ワークスペースの開閉状態に関わらず常に安全に許可してよい。
 * そのため wsRoots と allowedFiles は OR 条件で判定する
 * （バグ修正: 以前は wsRoots.length > 0 のとき allowedFiles が一切参照されず、
 * ワークスペース外のファイル・フォルダを解析対象にした場合にソースジャンプ/ソースパネルが
 * 常に失敗していた）。
 *
 * wsRoots・allowedFiles のいずれも該当しない場合は安全のため拒否する
 * （WebView から任意のパス（/etc/passwd 等）を要求できる脆弱性を防ぐ）。
 */
function isPathInWorkspace(
  filePath:     string,
  wsRoots:      string[],
  allowedFiles: ReadonlySet<string>
): boolean {
  const fileResolved = resolveAndNormalize(filePath);
  if (fileResolved === null) return false;
  // 現在のグラフに実在するファイルは、ワークスペースの有無によらず常に許可する。
  if (allowedFiles.has(fileResolved)) return true;
  // ワークスペースが開いている場合: フォルダ配下かどうかで判断
  if (wsRoots.length > 0) {
    return wsRoots.some(r => {
      const rResolved = resolveAndNormalize(r);
      if (rResolved === null) return false;
      return fileResolved === rResolved
        || fileResolved.startsWith(rResolved + path.sep)
        || fileResolved.startsWith(rResolved + '/');
    });
  }
  // ワークスペースなし・グラフにも未登録: 安全のため拒否
  return false;
}

const FILE_COLORS_BASE = [
  { background: '#ffeaa7', border: '#fdcb6e' },
  { background: '#fab1a0', border: '#e17055' },
  { background: '#a29bfe', border: '#6c5ce7' },
  { background: '#81ecec', border: '#00cec9' },
  { background: '#55efc4', border: '#00b894' },
  { background: '#fd79a8', border: '#e84393' },
  { background: '#74b9ff', border: '#0984e3' },
  { background: '#dfe6e9', border: '#b2bec3' },
];

function generateFileColors(files: string[]): Record<string, { background: string; border: string }> {
  const map: Record<string, { background: string; border: string }> = {};
  const extra = files.length - FILE_COLORS_BASE.length; // プリセット外のファイル数
  files.forEach((f, i) => {
    if (i < FILE_COLORS_BASE.length) {
      map[f] = FILE_COLORS_BASE[i];
    } else {
      // プリセット以降を 0 から数え直し、extra 個を色相環で均等配置する
      const hue = Math.round(((i - FILE_COLORS_BASE.length) * 360 / Math.max(1, extra)) % 360);
      map[f] = {
        background: `hsl(${hue},65%,80%)`,
        border:     `hsl(${hue},65%,55%)`,
      };
    }
  });
  return map;
}

/**
 * HTML/PNG/SVG 書き出し共通の保存ファイル名組み立て。
 * lsp_/gtags_ プレフィックス + (file/fn/path/ws/dir)サフィックス + 対象名 + 拡張子。
 * 元は exportHtmlFile 内にあった処理を、PNG/SVG エクスポートとも共用できるよう切り出したもの。
 */
// #1修正: callatlas.colorTheme 設定値を package.json の enum (auto/light/dark) に照合し、
// 外れていれば 'auto' にフォールバックする。
// 設定UI(ドロップダウン)はenumで制限されるが、.vscode/settings.json を直接編集
// (あるいはワークスペースに同梱)すれば任意の文字列を設定できてしまう。
// _buildHtml() はこの値を JSON.stringify() だけで(HTMLエスケープせずに)そのまま
// <script> タグへ埋め込んでいるため、信頼できないワークスペース設定によって
// HTML構造を壊される(新しい<script>タグ等を注入される)リスクがあった。
// 現状のCSP(nonce必須・'unsafe-inline'なし)によりJS実行までは到達しにくいが、
// 防御を1層に頼らないため、埋め込み前にここで検証する。
const COLOR_THEME_VALUES = new Set(['auto', 'light', 'dark']);
function resolveColorTheme(): 'auto' | 'light' | 'dark' {
  const raw = vscode.workspace.getConfiguration('callatlas').get<string>('colorTheme', 'auto');
  return COLOR_THEME_VALUES.has(raw) ? (raw as 'auto' | 'light' | 'dark') : 'auto';
}

function buildExportFileName(data: GraphData, ext: string): string {
  // FS 危険文字のみ除去し、空白は _ に、連続 _ は畳む。最大 80 文字。
  const sanitize = (s: string): string => s
    .replace(/[/\\:*?"<>|()]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g,  '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80) || 'graph';

  // 保存ファイル名の先頭に lsp_/gtags_ を付与し、どちらのバックエンドで解析した結果か分かるようにする。
  // data.backend が未設定(古いキャッシュ等)の場合はプレフィックスなしで従来通り。
  const backendPrefix = data.backend ? `${data.backend}_` : '';

  // data.subject(ワークスペース名/フォルダ名/ファイル名/関数名) + data.kind(省略系) で
  // 「どのコマンドで」「何を」解析した結果かをファイル名だけで判別できるようにする。
  // 古いキャッシュ等で subject/kind が未設定の場合は、旧来通り data.fileName から組み立てる。
  const KIND_SUFFIX: Record<string, string> = {
    file: 'file', func: 'fn', path: 'path', workspace: 'ws', folder: 'dir',
  };
  const subjectPart = sanitize(data.subject ?? data.fileName);
  const kindPart     = data.kind ? `${KIND_SUFFIX[data.kind]}_` : '';
  return `${backendPrefix}${kindPart}${subjectPart}.${ext}`;
}

function buildGraphMsg(data: GraphData): object {
  const files      = [...new Set(data.nodes.map(n => n.file))].sort();
  const colorMap   = generateFileColors(files);
  const fileLegend = files.map(f => ({ file: f, color: colorMap[f].background, border: colorMap[f].border }));
  return {
    type: 'graphData',
    nodes: data.nodes.map(n => ({
      id:            n.id,
      label:         n.label,
      labelFull:     n.labelFull,
      file:          n.file,
      line:          n.line,
      scopeEnd:      n.scopeEnd,   // lazy source 読み込み用（通常は source を送らない）
      isCurrentFile: n.isCurrentFile,
      color:  colorMap[n.file] ?? FILE_COLORS_BASE[FILE_COLORS_BASE.length - 1],
      // A2修正: 同梱の vis-network(package-lock解決版 9.1.13)の Popup 実装は
      // title 文字列を innerHTML ではなく innerText で挿入するため、HTMLエンティティや
      // <br> に変換すると "&#39;" や "<br>" がそのまま文字として表示されてしまっていた。
      // innerText は \n を改行として描画するため、エスケープ不要のプレーンテキストで渡す。
      // (innerText は HTML を解釈しないため XSS の余地も構造的にない)
      title:  `${n.label}\n${path.basename(n.file)} : line ${n.line}`,
    })),
    edges: data.edges, fileLegend,
    buildTimeMs: data.buildTimeMs, errors: data.errors,
    // callatlas.initialControlPanel 設定値をメッセージに含める。
    // webview.js の renderGraph で setControlsCollapsed() に渡して初期状態を適用する。
    controlPanelCollapsed: vscode.workspace.getConfiguration('callatlas')
      .get<string>('initialControlPanel', 'expanded') === 'collapsed',
    // callatlas.colorTheme 設定値(auto/light/dark)をメッセージに含める。
    // webview.js の applyColorTheme で解決し、パネル/ノード/エッジ配色に反映する。
    // スタンドアロンHTML書き出し版には vscode-dark 等のbodyクラスが無いため、
    // auto指定時は webview.js 側で prefers-color-scheme にフォールバックする。
    colorTheme: resolveColorTheme(),
  };
}

// vis-network.min.js / webview.js のインメモリキャッシュ。
// HTML エクスポートのたびに約 1MB の vis-network.min.js を readFile するのを避ける。
// Promise シングルトンパターンで並行呼び出し時の二重読み込みも防ぐ。
// 拡張機能のバージョンアップ時はプロセス再起動されるためキャッシュは常に有効。
let _filesCachePromise: Promise<[string, string]> | undefined;

async function generateStandaloneHtml(extensionUri: vscode.Uri, data: GraphData): Promise<string> {
  const distDir   = vscode.Uri.joinPath(extensionUri, 'dist').fsPath;
  // if チェックと await の間に別呼び出しが入っても Promise を再利用するため二重読み込みしない。
  // readFile が失敗した場合は catch でキャッシュをクリアして次回再試行を可能にする。
  if (!_filesCachePromise) {
    _filesCachePromise = Promise.all([
      fs.promises.readFile(path.join(distDir, 'vis-network.min.js'), 'utf-8'),
      fs.promises.readFile(path.join(distDir, 'webview.js'),         'utf-8'),
    ]).catch(err => {
      _filesCachePromise = undefined; // エラー時はキャッシュをクリアして次回再試行を可能にする
      throw err;
    });
  }
  const [visJs, webviewJs] = await _filesCachePromise;
  const graphMsg  = buildGraphMsg(data);

  // JSON.stringify は </script> をエスケープしないためソースコード中に含まれると HTML が破壊される。
  // Unicodeエスケープで < と > を無害化する。
  // U+2028 / U+2029 も一部パーサーで改行扱いされるためエスケープする。
  const safeJson = JSON.stringify(graphMsg)
    .replace(/</g,      '\\u003c')
    .replace(/>/g,      '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  // visJs / webviewJs をインラインで埋め込む際に </script> が含まれると
  // ブラウザの HTML パーサーがスクリプトブロックを早期終端してしまうため変換する。
  const escapeScript = (s: string): string => s.replace(/<\/script/gi, '<\\/script');

  return htmlTemplate({ kind: 'standalone' }, [
    `<script>var INITIAL_GRAPH_DATA = ${safeJson};</script>`,
    `<script>${escapeScript(visJs)}</script>`,
    `<script>${escapeScript(webviewJs)}</script>`,
  ].join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
// CallGraphPanel
// ─────────────────────────────────────────────────────────────────────────────

export class CallGraphPanel {
  public static currentPanel: CallGraphPanel | undefined;

  private readonly _panel:        vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _disposables:  vscode.Disposable[] = [];
  private _isReady          = false;
  // N10修正: 再読み込み後の復元用に、直近の状態メッセージを1件だけ保持する。
  private _lastState: object | null = null;
  // ready 受信前に複数メッセージが積まれても順番通りに届くようキュー方式にする
  private _pendingMessages: object[] = [];
  private _lastGraphData:  GraphData | null = null;
  // A8修正: パネル破棄後に非同期処理(build完了)から title 設定等を行うと
  // "Webview is disposed" 例外が未捕捉のまま投げられる。このフラグで各メソッドの
  // 先頭でガードし、破棄済みなら何もしない(結果は静かに破棄する)。
  private _disposed = false;
  // wsRoots が空の単一ファイル編集モードでのアクセス制限用に
  // グラフに含まれるファイルパス（正規化済み）のセットを保持する
  private _allowedFiles: Set<string> = new Set();

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel        = panel;
    this._extensionUri = extensionUri;

    this._panel.webview.onDidReceiveMessage(
      async (msg: { type: string; file?: string; line?: number; dataUrl?: string }) => {
        switch (msg.type) {
          case 'ready':
            this._isReady = true;
            if (this._pendingMessages.length > 0) {
              for (const pending of this._pendingMessages) {
                this._panel.webview.postMessage(pending);
              }
              this._pendingMessages = [];
            } else if (this._lastState) {
              // N10修正: WebViewが再読み込みされた場合(タブを別ウィンドウへ移動した時等)、
              // 2回目以降の ready では溜まっているメッセージが無いため、以前は
              // 何も再送されずグラフが空白のままになっていた。直近の状態メッセージ
              // (loading/graphData/error/cancelled)を1件保持しておき、再読み込み後の
              // 復元に使う。
              this._panel.webview.postMessage(this._lastState);
            }
            break;
          case 'openFile':
            if (msg.file && msg.line !== undefined) await this._openFileAtLine(msg.file, msg.line);
            break;
          case 'requestSource': {
            // ソース遅延読み込み: ノードクリック時にファイルを読んで返す
            // msg の宣言型に nodeId が含まれないため unknown 経由でキャストする
            const req = msg as unknown as { nodeId: string; file: string; line: number; scopeEnd?: number };
            const { nodeId, file, line, scopeEnd } = req;
            // WebView 由来の nodeId は型・長さを検証する。nodeId 自体が不正な場合は
            // 応答先を特定できないため例外的に無応答とする
            // (webview.js 自身が nodeId 抜きでこのメッセージを送ることはない)。
            if (!nodeId || typeof nodeId !== 'string' || nodeId.length > 1000) break;

            // A6修正: 以降の検証・読み込み失敗は全て sourceData で応答する。
            // 応答を返さず break するだけだと、webview 側の pendingSourceNodeId が
            // 解除されず「// Loading...」のまま固まってしまう(再クリックでしか復帰できない)。
            // 拒否理由は詳細を出しすぎず(フルパス等は含めない)、一律の文言にする。
            // #4修正: reject() 自体、および下の成功時 postMessage の直前で _disposed を
            // チェックする。realpath / readFile の await 中にユーザーがパネルを閉じると
            // 「Webview is disposed」例外で postMessage が失敗しうるため。
            const reject = () => {
              if (this._disposed) return;
              this._panel.webview.postMessage(
                { type: 'sourceData', nodeId, source: '// Cannot read source' });
            };

            if (!file || typeof file !== 'string' || line === undefined) { reject(); break; }
            const wsRoots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
            if (!isPathInWorkspace(file, wsRoots, this._allowedFiles)) { reject(); break; }
            // TOCTOU 対策: isPathInWorkspace のチェック後に realpath を再取得して
            // 「チェックしたパス = 読み取るパス」を一致させる
            let resolvedFile: string;
            try {
              resolvedFile = await fs.promises.realpath(path.resolve(file));
            } catch {
              reject(); break;
            }
            // 解決済みパスで再チェック（シンボリックリンクが変更された場合の二重確認）
            if (!isPathInWorkspace(resolvedFile, wsRoots, this._allowedFiles)) { reject(); break; }
            try {
              const content = await fs.promises.readFile(resolvedFile, 'utf-8');
              const lines   = content.split('\n');
              const startIdx = Math.max(0, line - 1);
              // WebView 由来の scopeEnd が NaN/Infinity の場合に備えて有限な正の整数のみ受け入れる
              const safeScopeEnd = (typeof scopeEnd === 'number' && isFinite(scopeEnd) && scopeEnd > 0)
                ? scopeEnd : undefined;
              const endIdx   = safeScopeEnd !== undefined
                ? Math.min(safeScopeEnd, startIdx + MAX_SOURCE_LINES, lines.length)
                : Math.min(startIdx + MAX_SOURCE_LINES, lines.length);
              const source = lines.slice(startIdx, endIdx).join('\n');
              if (this._disposed) break;
              this._panel.webview.postMessage({ type: 'sourceData', nodeId, source });
            } catch {
              reject();
            }
            break;
          }
          case 'exportHtml':
            if (this._lastGraphData) await CallGraphPanel.exportHtmlFile(this._extensionUri, this._lastGraphData);
            else vscode.window.showWarningMessage('No graph data to export.');
            break;
          case 'exportPng':
            // PNG は webview.js 側で作成した(3000px固定・全体表示・背景塗りつぶし済みの)
            // dataURL をそのまま受け取って書き込むだけ。
            if (!this._lastGraphData) { vscode.window.showWarningMessage('No graph data to export.'); break; }
            if (msg.dataUrl) await CallGraphPanel.exportImageFile(this._lastGraphData, msg.dataUrl);
            break;
        }
      },
      null, this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = this._buildHtml();
  }

  public static createOrShow(extensionUri: vscode.Uri): CallGraphPanel {
    // B14修正: 既存パネルを再利用する場合は列を再計算しない。
    // Regenerate はステータスバーのツールチップ内コマンドリンクから実行されるため、
    // グラフ(webview)にフォーカスがある状態で押されることが多く、その場合
    // vscode.window.activeTextEditor は undefined になる(webviewはテキストエディタ扱いではない)。
    // 従来はここで毎回 column を Beside/One に計算し直して reveal(column) していたため、
    // 右側に開いていたパネルが再生成のたびに左(ViewColumn.One)へ意図せず移動していた。
    // 既存パネルは列を指定せず reveal() することで、現在表示されている列のまま維持する。
    if (CallGraphPanel.currentPanel) {
      CallGraphPanel.currentPanel._panel.reveal();
      return CallGraphPanel.currentPanel;
    }
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(
      'callGraphViewer', 'Call Atlas', column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    CallGraphPanel.currentPanel = new CallGraphPanel(panel, extensionUri);
    return CallGraphPanel.currentPanel;
  }

  public setLoading(fileName: string): void {
    if (this._disposed) return;
    this._panel.title = 'Call Atlas — Analyzing...';
    this._postOrQueue({ type: 'loading', fileName });
  }

  public updateGraph(data: GraphData): void {
    if (this._disposed) return;
    this._lastGraphData = data;
    this._panel.title   = `Call Atlas — ${data.fileName}`;
    this._allowedFiles = new Set(
      data.nodes.map(n => resolveAndNormalize(n.file)).filter((p): p is string => p !== null)
    );
    this._postOrQueue(buildGraphMsg(data));
  }

  public showError(message: string): void {
    if (this._disposed) return;
    this._panel.title = 'Call Atlas — Error';
    this._postOrQueue({ type: 'error', message });
  }

  /**
   * ユーザーによるキャンセル時専用。showError() と違いパネルタイトルを
   * 「— Error」に変えない(キャンセルは失敗ではないため)。
   * ローディングスピナーがデフォルト表示のまま固まって見えるのを防ぐのが目的。
   */
  public showCancelled(): void {
    if (this._disposed) return;
    this._postOrQueue({ type: 'cancelled' });
  }

  public static async exportHtmlFile(extensionUri: vscode.Uri, data: GraphData): Promise<void> {
    const wsRoot     = vscode.workspace.workspaceFolders?.[0]?.uri;
    const finalName  = buildExportFileName(data, 'html');
    // ワークスペースがない場合は os.homedir() を使用（Windows で HOME 未定義になる問題に対応）
    const defaultUri = wsRoot
      ? vscode.Uri.joinPath(wsRoot, finalName)
      : vscode.Uri.file(path.join(os.homedir(), finalName));

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'HTML File': ['html'] },
    });
    if (!saveUri) return;

    try {
      const html = await generateStandaloneHtml(extensionUri, data);
      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html, 'utf-8'));
      const open = await vscode.window.showInformationMessage(
        `Saved: ${path.basename(saveUri.fsPath)}`, 'Open in Browser'
      );
      if (open === 'Open in Browser') await vscode.env.openExternal(saveUri);
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to save: ${e}`);
    }
  }

  /**
   * PNGエクスポート。実際のピクセルデータは webview.js 側(exportPngボタンのハンドラ)で
   * 作られたものをそのまま受け取って書き込むだけ(拡張機能ホスト側は DOM/canvas に
   * アクセスできないため)。webview側で既に「3000px固定幅・グラフ全体・現在のテーマ色で
   * 背景塗りつぶし済み」の状態に加工されたdata:URLが渡ってくる想定。
   */
  public static async exportImageFile(data: GraphData, dataUrl: string): Promise<void> {
    const wsRoot     = vscode.workspace.workspaceFolders?.[0]?.uri;
    const finalName  = buildExportFileName(data, 'png');
    const defaultUri = wsRoot
      ? vscode.Uri.joinPath(wsRoot, finalName)
      : vscode.Uri.file(path.join(os.homedir(), finalName));

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'PNG Image': ['png'] },
    });
    if (!saveUri) return;

    try {
      // dataUrl は "data:image/png;base64,xxxx" 形式。ヘッダ部分を除いてデコードする。
      const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      await vscode.workspace.fs.writeFile(saveUri, buf);
      const open = await vscode.window.showInformationMessage(
        `Saved: ${path.basename(saveUri.fsPath)}`, 'Reveal in Explorer'
      );
      if (open === 'Reveal in Explorer') await vscode.commands.executeCommand('revealFileInOS', saveUri);
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to save: ${e}`);
    }
  }

  /**
   * パネルが閉じられた(dispose された)ときに呼ばれるリスナーを登録する。
   * extension.ts の buildAndOutput() が、パネルを閉じたらビルドもキャンセルするために使う。
   * this._panel.onDidDispose は複数リスナー登録に対応しているため、
   * コンストラクタで登録済みの内部リスナー(dispose()を呼ぶ)とは独立して動作する。
   */
  public onDidClose(listener: () => void): vscode.Disposable {
    return this._panel.onDidDispose(listener);
  }

  public dispose(): void {
    this._disposed = true;
    CallGraphPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }

  private _postOrQueue(msg: object): void {
    this._lastState = msg; // 状態メッセージは常に最後の1件で上書きされる(再読み込み復元用)
    if (this._isReady) this._panel.webview.postMessage(msg);
    else this._pendingMessages.push(msg);
  }

  private async _openFileAtLine(filePath: string, line: number): Promise<void> {
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    if (!isPathInWorkspace(filePath, wsRoots, this._allowedFiles)) {
      vscode.window.showErrorMessage(
        `Call Atlas: Cannot open file outside workspace:\n${filePath}`);
      return;
    }
    // TOCTOU 対策: 検証済みの実パスで URI を生成する
    let resolvedPath: string;
    try {
      resolvedPath = await fs.promises.realpath(path.resolve(filePath));
    } catch {
      vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
      return;
    }
    // 解決後のパスで再チェック（シンボリックリンクが変更された場合の二重確認）
    if (!isPathInWorkspace(resolvedPath, wsRoots, this._allowedFiles)) {
      vscode.window.showErrorMessage(
        `Call Atlas: Cannot open file outside workspace:\n${resolvedPath}`);
      return;
    }
    try {
      const uri = vscode.Uri.file(resolvedPath);
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
    } catch {
      vscode.window.showErrorMessage(`Could not open file: ${resolvedPath}`);
    }
  }

  private _buildHtml(): string {
    const nonce      = crypto.randomBytes(16).toString('hex');
    const webview    = this._panel.webview;
    const distDir    = vscode.Uri.joinPath(this._extensionUri, 'dist');
    const visUri     = webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'vis-network.min.js'));
    const webviewUri = webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'webview.js'));
    // callatlas.colorTheme を早期(vis-network/webview.js 読み込み前)にグローバル変数として渡す。
    // 実際のグラフデータは後から 'graphData' postMessage(buildGraphMsg)で届くが、
    // それを待つと最初の一瞬だけ常にライトカラーで描画されてしまう(ちらつき)ため、
    // 設定値だけは HTML 生成時点で先に埋め込んでおく。
    // #1修正: 生の設定値ではなく resolveColorTheme() で enum 照合済みの値を使う
    // (理由は resolveColorTheme() 定義部のコメント参照)。
    const colorTheme = resolveColorTheme();

    return htmlTemplate(
      { kind: 'webview', nonce, cspSource: webview.cspSource },
      `<script nonce="${nonce}">window.__CALLATLAS_COLOR_THEME__=${JSON.stringify(colorTheme)};</script>\n` +
      `<script nonce="${nonce}" src="${visUri}"></script>\n<script nonce="${nonce}" src="${webviewUri}"></script>`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML テンプレート (WebView / スタンドアロン 共用)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * webview / standalone の判別を共用体型で行う。
 * nonce が空文字列のときに誤って standalone 扱いになるバグを型レベルで排除する。
 */
type HtmlTemplateMode =
  | { kind: 'webview';    nonce: string; cspSource: string }
  | { kind: 'standalone' };

function htmlTemplate(mode: HtmlTemplateMode, scripts: string): string {
  const cspMeta = mode.kind === 'webview'
    ? `<meta http-equiv="Content-Security-Policy"
         content="default-src 'none'; script-src 'nonce-${mode.nonce}' ${mode.cspSource}; style-src 'unsafe-inline'; img-src data: blob:;">`
    : `<meta http-equiv="Content-Security-Policy"
         content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; object-src 'none'; base-uri 'none';">`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${cspMeta}
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
/* callatlas.colorTheme (auto/light/dark) 用パレット。
   既定値はここに書くライトカラーで、webview.js が起動時に
   document.documentElement へ atlas-dark クラスを付け外しして切り替える。
   ノード/エッジのアクセントカラー(選択・callee・caller等)は
   キャンバスの明暗どちらでも視認性を保てるため変更せず、
   ここでは「パネル・キャンバス背景・通常文字色」など
   キャンバス明暗に応じて読みにくくなる要素だけを変数化する。 */
:root {
  --atlas-bg:           #f8f9fa;
  --atlas-bg-overlay:   rgba(248,249,250,0.92);
  --atlas-panel-bg:     rgba(255,255,255,0.95);
  --atlas-panel-border: #ddd;
  --atlas-text:         #2d3436;
  --atlas-text-sub:     #636e72;
  --atlas-text-faint:   #b2bec3;
  --atlas-text-hint:    #aaaaaa;
  --atlas-border:       #b2bec3;
  --atlas-input-bg:     #ffffff;
  --atlas-btn-bg:       #f0f0f0;
  --atlas-btn2-bg:      #dfe6e9;
  --atlas-modal-bg:     #ffffff;
  --atlas-spinner-track:#dfe6e9;
  --atlas-scroll-track: #ffffff;
  --atlas-navbtn-filter: grayscale(100%) brightness(0.6);
  --atlas-navbtn-opacity: 0.65;
  --atlas-navbtn-hover-bg: rgba(100,100,100,0.15);
}
html.atlas-dark {
  --atlas-bg:           #1e1e1e;
  --atlas-bg-overlay:   rgba(30,30,30,0.92);
  --atlas-panel-bg:     rgba(37,37,38,0.95);
  --atlas-panel-border: #3c3c3c;
  --atlas-text:         #d4d4d4;
  --atlas-text-sub:     #9d9d9d;
  --atlas-text-faint:   #6e6e6e;
  --atlas-text-hint:    #6e6e6e;
  --atlas-border:       #5a5a5a;
  --atlas-input-bg:     #3c3c3c;
  --atlas-btn-bg:       #3c3c3c;
  --atlas-btn2-bg:      #464646;
  --atlas-modal-bg:     #2d2d30;
  --atlas-spinner-track:#3c3c3c;
  --atlas-scroll-track: #252526;
  /* B15修正: ナビゲーションボタン(左下のパン/ズームアイコン)は vis-network が
     元々「明るいキャンバス向けの暗いグレーPNGアイコン」を描画する。ライト用の
     指定(grayscale+brightness(0.6))のまま暗いキャンバスに乗せると、暗いアイコンが
     暗い背景に溶けて見えなくなるため、ダーク時は invert(1) で明るい色に反転する。 */
  --atlas-navbtn-filter: grayscale(100%) invert(1) brightness(1.3);
  --atlas-navbtn-opacity: 0.8;
  --atlas-navbtn-hover-bg: rgba(255,255,255,0.18);
}
html, body { width: 100%; height: 100%; overflow: hidden; background: var(--atlas-bg); color: var(--atlas-text); }
#network { width: 100%; height: 100vh; }
div.vis-network div.vis-navigation div.vis-button {
  background-color: transparent !important; border-radius: 4px !important;
  border: none !important; filter: var(--atlas-navbtn-filter) !important;
  opacity: var(--atlas-navbtn-opacity); transition: opacity 0.15s, filter 0.15s;
}
div.vis-network div.vis-navigation div.vis-button:hover { background-color: var(--atlas-navbtn-hover-bg) !important; opacity: 1.0; }
div.vis-network div.vis-navigation div.vis-button.vis-up    { left: 38px !important; bottom: 76px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-left  { left:  0px !important; bottom: 38px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-right { left: 76px !important; bottom: 38px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-down  { left: 38px !important; bottom:  0px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-zoomIn      { left: 122px !important; bottom: 76px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-zoomExtends { left: 122px !important; bottom: 38px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-zoomOut     { left: 122px !important; bottom:  0px !important; right: auto !important; }
#controls {
  position: fixed; top: 12px; left: 12px; z-index: 999;
  background: var(--atlas-panel-bg); border: 1px solid var(--atlas-panel-border);
  border-radius: 8px; padding: 12px 14px; font-family: monospace;
  font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  width: auto; line-height: 1.8; color: var(--atlas-text);
}
#search-box {
  width: 100%; padding: 5px 8px; border: 1px solid var(--atlas-border);
  border-radius: 5px; font-family: monospace; font-size: 12px;
  outline: none; margin-bottom: 8px; box-sizing: border-box;
  background: var(--atlas-input-bg); color: var(--atlas-text);
}
.hop-btn { flex: 1; padding: 4px 0; border: 1px solid var(--atlas-border); border-radius: 4px; cursor: pointer; background: var(--atlas-btn2-bg); color: var(--atlas-text); font-family: monospace; font-size: 12px; }
.hop-btn.active { background: #636e72 !important; color: #fff !important; }
.search-mode-btn { flex: 1; padding: 3px 0; border: 1px solid var(--atlas-border); cursor: pointer; background: var(--atlas-btn2-bg); font-family: monospace; font-size: 11px; color: var(--atlas-text-sub); }
.search-mode-btn:first-child { border-radius: 4px 0 0 4px; }
.search-mode-btn:last-child  { border-radius: 0 4px 4px 0; border-left: none; }
.search-mode-btn.active { background: #636e72 !important; color: #fff !important; }
.export-btn { flex: 1; padding: 4px 0; border: 1px solid var(--atlas-border); border-radius: 4px; cursor: pointer; background: var(--atlas-btn-bg); color: var(--atlas-text); font-family: monospace; font-size: 11px; }
#source-panel {
  display: none; position: fixed; top: 0; right: 0; bottom: 0;
  width: 40%; max-width: 600px; z-index: 998;
  background: #1e1e2e; color: #cdd6f4; font-family: monospace; font-size: 13px;
  flex-direction: column; border-left: 2px solid #45475a; box-shadow: -4px 0 16px rgba(0,0,0,0.2);
}
#source-placeholder { display: flex; flex: 1; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: #6c7086; }
#source-content { display: none; flex-direction: column; flex: 1; overflow: hidden; }
#source-code { margin: 0; padding: 16px; overflow: auto; flex: 1; line-height: 1.6; white-space: pre; color: #cdd6f4; background: #1e1e2e; }
#loading-overlay {
  /* display:none ではなく最初から flex(表示)にしておく。
     以前は showLoading() の postMessage が届くまで何も表示されず、
     パネルが開いてから ready ハンドシェイク+メッセージが届くまでの
     一瞬(短いが体感的に「固まった?」と感じさせる)が空白になっていた。
     HTML/CSS だけで即座にスピナーを出し、実データ到着(renderGraph内の
     hideLoading())で消す方式にすることで、その空白を無くす。
     standalone エクスポート版でも INITIAL_GRAPH_DATA 処理中の一瞬
     スピナーが見えるだけで、実害はない。 */
  display: flex; position: fixed; inset: 0; z-index: 9999;
  background: var(--atlas-bg-overlay); align-items: center; justify-content: center;
  flex-direction: column; gap: 16px; font-family: monospace;
}
.spinner { width: 36px; height: 36px; border: 3px solid var(--atlas-spinner-track); border-top-color: #00b894; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* ネイティブ number スピナーを非表示にして見切れを防ぐ */
#font-size-input::-webkit-inner-spin-button,
#font-size-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
#font-size-input { -moz-appearance: textfield; text-align: center; }
/* コントロールパネル折りたたみ */
#controls-toggle {
  background: none; border: none; cursor: pointer;
  font-size: 12px; color: var(--atlas-text-sub); padding: 0 2px; line-height: 1;
  transition: transform 0.15s;
}
#controls-toggle.collapsed { transform: rotate(-90deg); }
#controls-body { overflow: hidden; }
/* 警告詳細モーダル (alert()/confirm() は webview の sandboxed iframe では
   動作しないため、代わりに自前の DOM モーダルで表示する) */
.modal-overlay {
  display: none; position: fixed; inset: 0; z-index: 10001;
  background: rgba(0,0,0,0.35); align-items: center; justify-content: center;
}
.modal-box {
  background: var(--atlas-modal-bg); border-radius: 8px; width: 480px; max-width: 90vw;
  max-height: 70vh; display: flex; flex-direction: column;
  box-shadow: 0 4px 20px rgba(0,0,0,0.25); font-family: monospace;
}
.modal-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 14px; border-bottom: 1px solid var(--atlas-panel-border); font-size: 13px; color: #e17055;
}
.modal-header button {
  background: none; border: none; cursor: pointer; font-size: 15px; color: var(--atlas-text-sub);
}
.modal-body {
  margin: 0; padding: 12px 14px; overflow: auto; font-size: 11px;
  color: var(--atlas-text); white-space: pre-wrap; word-break: break-word;
}
/* ファイル凡例のスクロールバーをパネルと同系色に */
#legend-items { scrollbar-width: thin; scrollbar-color: var(--atlas-border) var(--atlas-scroll-track); }
#legend-items::-webkit-scrollbar { width: 8px; }
#legend-items::-webkit-scrollbar-button { display: none; height: 0; width: 0; }
#legend-items::-webkit-scrollbar-track { background: var(--atlas-scroll-track); }
#legend-items::-webkit-scrollbar-thumb { background: var(--atlas-border); border-radius: 4px; }
#legend-items::-webkit-scrollbar-thumb:hover { background: #838c91; }
</style>
</head>
<body>
<div id="network"></div>

<div id="controls">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
    <b style="font-size:13px;">📞 Call Atlas</b>
    <button id="controls-toggle" title="Collapse panel">▼</button>
  </div>
  <div id="controls-body">
  <div style="color:var(--atlas-text-sub);font-size:11px;margin:2px 0 8px;">
    <b style="color:#97c2fc;">●</b> selected &nbsp;
    <b style="color:#e17055;">●</b> callee &nbsp;
    <b style="color:#00b894;">●</b> caller &nbsp;
    <span style="color:var(--atlas-text-hint);font-size:10px;">Ctrl/Cmd+Click to jump</span>
  </div>
  <div id="build-info" style="margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--atlas-panel-border);color:var(--atlas-text-faint);font-size:10px;"></div>
  <div style="display:flex;margin-bottom:4px;">
    <button class="search-mode-btn active" id="search-mode-func" title="Search by function name">func</button>
    <button class="search-mode-btn active" id="search-mode-file" title="Search by file name">file</button>
  </div>
  <input id="search-box" type="text" placeholder="🔍 Search">

  <label style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--atlas-text);margin-bottom:4px;">
    <input id="sig-toggle" type="checkbox" style="cursor:pointer;"> Show parameters
  </label>
  ${mode.kind === 'webview'
    ? `<label style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--atlas-text);margin-bottom:4px;">
    <input id="src-toggle" type="checkbox" style="cursor:pointer;"> Show source panel
  </label>`
    // C4修正: standalone HTML書き出し版はソースコードを埋め込んでいないため、
    // このチェックボックスを有効にしても常に "(Source not found)" になっていた。
    // id="src-toggle" 自体はwebview.js側の要素参照を壊さないよう残しつつ、
    // disabledにして無条件でチェックが入らないようにし(=showSourceを誘発しない)、
    // 理由をtitleで明示する。
    : `<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--atlas-text-faint);margin-bottom:4px;" title="Source code is not embedded in this standalone export. Reopen the analysis from VS Code to view source.">
    <input id="src-toggle" type="checkbox" disabled style="cursor:not-allowed;"> Show source panel (unavailable in standalone export)
  </label>`}
  <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--atlas-text-sub);margin-bottom:6px;">
    <label for="font-size-input" style="white-space:nowrap;">Font size:</label>
    <button id="font-size-down" style="width:22px;height:22px;border:1px solid var(--atlas-border);border-radius:4px;background:var(--atlas-btn-bg);font-size:13px;line-height:1;cursor:pointer;color:var(--atlas-text-sub);padding:0;display:flex;align-items:center;justify-content:center;">－</button>
    <input id="font-size-input" type="number" value="11" min="6" max="64"
      style="width:38px;height:22px;padding:0 2px;border:1px solid var(--atlas-border);border-radius:4px;font-family:monospace;font-size:11px;outline:none;background:var(--atlas-input-bg);color:var(--atlas-text);">
    <button id="font-size-up" style="width:22px;height:22px;border:1px solid var(--atlas-border);border-radius:4px;background:var(--atlas-btn-bg);font-size:13px;line-height:1;cursor:pointer;color:var(--atlas-text-sub);padding:0;display:flex;align-items:center;justify-content:center;">＋</button>
    <button id="font-size-reset" style="padding:2px 7px;height:22px;border:1px solid var(--atlas-border);border-radius:4px;background:var(--atlas-btn-bg);font-family:monospace;font-size:11px;cursor:pointer;color:var(--atlas-text-sub);">Reset</button>
  </div>
  ${mode.kind === 'webview' ? `<div style="display:flex;gap:5px;margin-bottom:6px;">
    <button id="export-html-btn" class="export-btn" title="Save as a standalone HTML file">💾 HTML</button>
    <button id="export-png-btn" class="export-btn" title="Save the whole graph as a PNG image">🖼️ PNG</button>
  </div>` : ''}
  <div id="hop-panel" style="display:none;margin-top:2px;">
    <div style="color:var(--atlas-text-sub);font-size:11px;margin-bottom:4px;">Hop filter:</div>
    <div style="display:flex;gap:5px;">
      <button class="hop-btn" data-hop="1">1</button>
      <button class="hop-btn" data-hop="2">2</button>
      <button class="hop-btn" data-hop="3">3</button>
      <button class="hop-btn" data-hop="all">All</button>
    </div>
  </div>
  <div style="margin-top:10px;border-top:1px solid var(--atlas-panel-border);padding-top:8px;">
    <div style="color:var(--atlas-text-sub);font-size:11px;margin-bottom:5px;">File legend:</div>
    <div id="legend-items" style="max-height:180px;overflow-y:auto;"></div>
  </div>
  </div><!-- #controls-body -->
</div>

<div id="source-panel">
  <div id="source-placeholder">
    <span style="font-size:28px;">←</span>
    <span style="font-size:13px;">Click a node</span>
    <span style="font-size:11px;color:#6c7086;">Ctrl/Cmd+Click to jump to editor</span>
  </div>
  <div id="source-content">
    <div style="padding:10px 16px;background:#181825;border-bottom:1px solid #45475a;display:flex;justify-content:space-between;align-items:flex-start;flex-shrink:0;">
      <div>
        <span id="source-func-name" style="color:#89b4fa;font-weight:bold;font-size:14px;"></span><br>
        <span id="source-file-info" style="color:#6c7086;font-size:11px;"></span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-left:8px;">
        <button id="goto-btn" style="background:#313244;border:1px solid #45475a;color:#cdd6f4;cursor:pointer;padding:4px 10px;border-radius:4px;font-family:monospace;font-size:11px;">▷ Go to source</button>
        <button id="src-close-btn" style="background:none;border:none;color:#6c7086;cursor:pointer;font-size:16px;">✕</button>
      </div>
    </div>
    <pre id="source-code"></pre>
  </div>
</div>

<div id="loading-overlay">
  <div class="spinner"></div>
  <div id="loading-msg" style="font-family:monospace;color:var(--atlas-text-sub);font-size:13px;">Analyzing...</div>
</div>

<div id="warning-modal" class="modal-overlay">
  <div class="modal-box">
    <div class="modal-header">
      <b>⚠️ Build warnings (<span id="warning-count"></span>)</b>
      <button id="warning-modal-close" type="button" title="Close">✕</button>
    </div>
    <pre id="warning-modal-body" class="modal-body"></pre>
  </div>
</div>

${scripts}
</body>
</html>`;
}