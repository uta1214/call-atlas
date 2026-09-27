# Call Atlas

**Call Atlas** is a VS Code extension that visualizes interactive call graphs of C/C++ projects.  
It supports two analysis backends: **LSP** (using the Call Hierarchy API) for high accuracy, and **gtags** (using GNU GLOBAL) for speed.

---

## Key Features

![Call Atlas demo](images/demo.gif)

### Call Graph Analysis
- **File Graph**: Analyze all functions in the current file and display their call relationships
- **Function Graph**: Start from the function at the cursor position and expand via BFS up to N hops
- **Workspace Graph**: Cross-file analysis across multiple C/C++ source files
- **Folder Graph**: Analyze all C/C++ files within a selected folder
- **Dual Backend**:
  - **LSP** — Uses clangd / C/C++ extension. High accuracy with full type resolution. Requires an LSP index.
  - **gtags** — Uses GNU GLOBAL. Fast analysis without LSP. Suitable for large projects.

### Interactive Graph View
- Click nodes to highlight callers (green) and callees (orange)
- **Hop filter**: Show only nodes within N hops of the selected node
- **Search box**: Filter by function name with Enter-to-focus and Esc-to-reset
- **Source code panel**: View source inline and jump to editor
- **File legend**: Per-file color coding
- **Font size control**
- **Collapsible control panel**: Hide the control panel to maximize graph area
- **HTML export**: Save as a standalone HTML file for sharing

---

## Installation

### Visual Studio Code Marketplace
https://marketplace.visualstudio.com/items?itemName=uta-orange-1214.call-atlas

### Manual Installation
1. Clone or download this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build
4. Run `vsce package` to create a `.vsix` file
5. In VS Code, open **Extensions** → `...` → **Install from VSIX**

---

## Usage

### Basic Usage
1. Open a C/C++ file in the editor
2. Right-click to open the context menu, or open the Command Palette (`Ctrl+Shift+P`)
3. Select a command, then choose a **backend** (LSP or gtags) and an **output mode** (WebView or HTML file)

### Commands
| Command | Description |
|---------|-------------|
| `Call Atlas: Analyze Workspace` | Cross-file analysis across the workspace |
| `Call Atlas: Analyze Folder` | Analyze all C/C++ files in a selected folder |
| `Call Atlas: Show File Call Graph` | Analyze all functions in the current file |
| `Call Atlas: Show Function Graph (BFS)` | Expand from the function at the cursor position |
| `Call Atlas: Show Path-Through Graph` | Bidirectional graph centered on the cursor function (LSP and gtags) |

### Keybindings
| Feature | Key |
|---------|-----|
| Analyze Workspace | `Ctrl+Alt+W` |
| Analyze Folder | `Ctrl+Alt+L` |
| Show File Call Graph | `Ctrl+Alt+M` |
| Show Function Graph  | `Ctrl+Alt+F` |
| Show Path-Through Graph | `Ctrl+Alt+P` |

### Graph Operations
| Action | Description |
|--------|-------------|
| Click node | Highlight callers (green) and callees (orange) |
| Ctrl / Cmd + Click node | Jump to source in editor |
| Hop buttons (1 / 2 / 3 / All) | Show only nodes within N hops of selected node |
| 🔍 Search box | Filter by function name (Enter to focus next hit, Shift+Enter for previous, Esc to reset) |
| Source panel checkbox | Toggle the source code panel |
| ▼ / ▶ toggle button | Collapse / expand the control panel |
| Double-click / Esc | Deselect and reset |
| Ctrl + Wheel | Zoom |
| Shift + Wheel | Horizontal scroll |
| Wheel | Vertical scroll |

---

## Configuration

### Main Settings

#### Analysis Settings
- `callatlas.defaultBackend`: Default backend for call graph analysis
  - `lsp`: Use LSP (clangd / C/C++ extension) — high accuracy
  - `gtags`: Use GNU GLOBAL (gtags) — fast, no LSP required
  - Default: `ask`
- `callatlas.maxHops`: Maximum number of BFS hops for Function Graph / Path-Through Graph
  - Default: `0` (unlimited). Set to `1` or higher to cap the depth if graphs get too heavy.
- `callatlas.gtagsUpdateInterval`: How often to run `global -u` to refresh the gtags database
  - `always` / `5` / `30` / `60` (minutes) / `off`
  - Default: `5`. `off` means Call Atlas never runs `global -u` automatically; you're expected to run `gtags` yourself when needed (useful for very large trees where re-scanning is slow).

#### Output Settings
- `callatlas.defaultOutputMode`: Default output mode
  - `webview`: Always open in WebView without asking
  - `html`: Always save as HTML without asking
  - Default: `ask`

#### Display Settings
- `callatlas.warnThreshold`: Warn when the number of files to analyze exceeds this value
  - Default: `30`
- `callatlas.initialControlPanel`: Initial visibility of the control panel when the graph opens
  - `expanded`: Show the control panel (default)
  - `collapsed`: Hide the control panel to maximize the graph area

### Caching
- **LSP results are never cached** — every analysis re-queries the language server, since the result depends on the live document buffer and the language server's current index state (which can itself become stale — see the indexing note below).
- **gtags results are cached for 5 minutes**, keyed by file/function/workspace and backend. A result with 0 nodes or any warnings is not cached, and the cache for `File`/`Function`/`Path-Through` Graph is cleared whenever any C/C++ file in the workspace changes (since a graph can depend on files other than the one it was built from). Cached results also aren't used while the source document has unsaved changes.
- If you ever suspect you're looking at a stale result, the safest fix is to save the file (which invalidates the relevant caches) and re-run the analysis.

---

## Requirements

- VS Code 1.85 or later
- **For LSP backend** — one of the following C/C++ language server extensions:
  - **clangd** (`llvm-vs-code-extensions.vscode-clangd`) ← **strongly recommended**
  - **C/C++** (`ms-vscode.cpptools`) — ⚠️ Known issue: cpptools' Call Hierarchy provider can silently omit some caller edges when multiple "Callers Of" lookups are expanded concurrently ([microsoft/vscode-cpptools#11747](https://github.com/microsoft/vscode-cpptools/issues/11747), open as of writing). This mainly affects Function Graph / Path-Through Graph, which can expand many hops at once. Use clangd if you need reliable results for deep/wide graphs.
- **For gtags backend** — GNU GLOBAL must be installed and available in PATH:
  - macOS: `brew install global`
  - Ubuntu/Debian: `sudo apt install global`
  - Windows: download from [GNU GLOBAL website](https://www.gnu.org/software/global/)
  - Call Atlas automatically creates `GTAGS` / `GRTAGS` / `GPATH` files directly under each workspace folder it analyzes with gtags, and refreshes them with `global -u` (see `callatlas.gtagsUpdateInterval`). **Add these three files to your `.gitignore`** if they aren't already covered by an existing ignore rule.
  - gtags requires an open workspace folder (`File > Open Folder...`), since it needs somewhere to place those files. The LSP backend does not have this requirement.

> **Which files are analyzed**: Call Atlas skips common generated/vendor directories anywhere under the workspace (`node_modules`, `build`, `dist`, `out`, `.git`, `CMakeFiles`, `_build`, `_deps`, `cmake-build-debug`, `cmake-build-release`, `.cache`, `.ccls-cache`, `vendor`, `.deps`), so a `src/build/` folder that's actually part of your source tree will also be skipped. This list isn't currently user-configurable.

> **Tip for clangd users**: Having `compile_commands.json` in your project root greatly improves accuracy.
> Generate it with `cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` (CMake) or `bear -- make` (Bear).

### Remote development (SSH / Dev Containers / Codespaces / WSL)

Call Atlas runs on the machine where your workspace lives, so it also works in remote windows.
The extension and the tools it uses must be available **on the remote side**:

- Install the extension in the remote as well (VS Code offers "Install in SSH: <host>" /
  "Install in WSL: <distro>" on the extension page). For Dev Containers / Codespaces, add
  `uta-orange-1214.call-atlas` to `customizations.vscode.extensions` in `devcontainer.json`.
- Install clangd (LSP backend) and/or GNU GLOBAL (gtags backend) on the remote machine or in the
  container (for example `apt install global` in your Dockerfile).
- Opening a WSL folder via `\\wsl$\...` from a Windows-side VS Code window is not supported.
  Use the WSL extension (Remote - WSL) instead.
- VS Code for the Web (vscode.dev / github.dev) and virtual workspaces are not supported (Call Atlas
  needs a real file system and locally-installed tools).

### Windows notes

- After installing GNU GLOBAL, add the folder containing `gtags.exe` / `global.exe` to `PATH` and
  **restart VS Code**. Check with `gtags --version` in the integrated terminal.
  Only `.exe` executables are found (wrapper scripts such as `.cmd` files are not).
- Native Windows hasn't been verified as thoroughly as Linux/macOS/WSL — feedback is welcome if
  you run into anything unexpected.

---

## Troubleshooting

### LSP: No symbols found
1. Verify that clangd or C/C++ extension is installed and enabled
2. Wait for the background index to complete (see status bar)
3. If using clangd: check that `compile_commands.json` exists in your project root

### gtags: No tags found
1. Verify that `gtags` is installed and available in PATH: `gtags --version`
2. Verify that `GTAGS`, `GRTAGS`, and `GPATH` files exist in your project root
3. Run `gtags` manually in the project root to generate the database

### Graph is empty
- Confirm that the file contains C/C++ function definitions recognized by the language server
- For gtags backend, make sure the project root is open as a workspace folder in VS Code

### Symbolic links are not followed
- `Analyze Folder` and `Analyze Workspace` do not follow symbolic links intentionally.
  If your project relies on symlinked source directories, add the real directory as a workspace folder instead.

### Function Graph (BFS) behavior differs between backends
- Both LSP and gtags backends perform **downward BFS only** (callee direction) for the `Show Function Graph (BFS)` command.
- If you need a bidirectional graph (both callers and callees), use the `Show Path-Through Graph` command.
- **Cursor position handling also differs**: with the LSP backend, the cursor must be on the function's name itself (VS Code's Call Hierarchy provider requires this). With gtags, any line inside the function's body works — Call Atlas finds the enclosing function by line range.

### LSP (cpptools): Some caller edges are missing
- If you're using the **C/C++ extension (cpptools)** as your LSP backend, this is a known cpptools bug, not a Call Atlas bug: cpptools' Call Hierarchy provider can silently return an empty result for some "Callers Of" lookups when several are expanded at once ([microsoft/vscode-cpptools#11747](https://github.com/microsoft/vscode-cpptools/issues/11747)). It tends to show up in Function Graph / Path-Through Graph, where many hops get expanded concurrently.
- Switching to the **clangd** extension has resolved this in testing. If you must use cpptools, results for deep graphs should be treated as potentially incomplete.

### LSP: Edges to other files are missing right after opening the project
- This can happen with **either clangd or cpptools**, not just cpptools: both language servers build a background index of the workspace, and Call Hierarchy queries against files that aren't indexed yet can silently return incomplete results.
- It's most noticeable on functions whose callees are *all* defined in other files (e.g. an initialization function that just calls each module's `_init()`), since every one of those edges depends on cross-file resolution.
- Wait for the language server's indexing to finish (check the status bar — clangd shows "indexing...", cpptools shows a similar progress indicator) before running an analysis, then re-run if you analyzed too early. This isn't a Call Atlas bug; it's inherent to how LSP servers build their index.

---

## Known Limitations

- **C++ overloaded / same-named methods**: functions are indexed by file + base name (without argument types), so overloaded functions or same-named methods on different classes within one file can occasionally resolve to the wrong node. Not yet verified against a real C++ project — treat C++ results with extra caution until this is confirmed.
- **gtags function-end approximation**: gtags estimates where a function ends by using the start of the *next* function in the file (or end-of-file for the last one), since it doesn't parse braces. Anything sitting between the end of a function's actual body and the next function's start — a function-pointer table (`static const struct ops my_ops = { .open = my_open, ... };`), a trailing macro, etc. — can be miscounted as a call from that function. This is a known source of extra edges with the gtags backend that LSP won't show.
- **gtags call detection is regex-based, not a real parser**: it can mistake a member call like `dev->init()` for a call to a standalone function named `init`, and for C++14+ digit separators (`1'000'000`), it reads past the `'` to the end of the line, which can throw off detection on that line. These are inherent to gtags' lightweight text-based approach.
- **Default keybindings may conflict**: `Ctrl+Alt+W/L/M/F/P` can collide with desktop-environment shortcuts on Linux, or with AltGr-based characters on some non-US keyboard layouts. If a shortcut doesn't trigger, rebind it via `File > Preferences > Keyboard Shortcuts` (search for "Call Atlas").
- **Workspace/Folder analysis scope differs by backend**: with gtags, after building the initial graph it also expands *upward* (callers) without limit across the whole workspace, so you may see more caller edges than with LSP, which only expands one hop outward per file. This is intentional (gtags is fast enough to do this eagerly), but can make the graph noticeably larger for big projects.
- **gtags: folder names containing spaces**: tags in a sub-folder whose name contains a space (e.g. `src/My Module/`) are skipped, because the output of `global -x` is split on whitespace. (The workspace root path itself is not affected.) Rename the folder or use the LSP backend. Call Atlas now warns when this happens (`[gtags] Skipped N reference(s)...`), so it shows up as a warning rather than a silent gap.
- **Source encoding**: the source panel reads files as UTF-8. Comments and strings in Shift_JIS or EUC-JP files may appear garbled. The analysis itself (function names and edges) is not affected.
- **No safety limit on graph size**: neither the number of nodes nor the BFS depth (for File Graph, or Function/Path-Through Graph with `callatlas.maxHops` left at its default of `0`) is capped. A "hub" function that many other functions call (logging, assertions, memory allocation, etc.) can pull a large fraction of a big project into a single graph, which takes a long time to build and can be hard to read once it's open. If you hit this, set `callatlas.maxHops` to a small number, or analyze a smaller File/Folder scope instead of the whole workspace. You can always cancel an in-progress analysis from the Call Atlas status bar item (hover over it and use the Cancel link in the tooltip).

---

## License

This project is licensed under the MIT License. (See LICENSE file)
Free to use, modify, and redistribute.

---

## Author

uta

---

## Repository

https://github.com/uta1214/call-atlas

---

# 日本語版 (Japanese)

# Call Atlas

**Call Atlas** は C/C++ プロジェクト向けのインタラクティブコールグラフ VSCode 拡張機能です。  
**LSP**（Call Hierarchy API 使用）による高精度解析と、**gtags**（GNU GLOBAL 使用）による高速解析の2バックエンドに対応しています。

---

## 主な機能

![Call Atlas demo](images/demo.gif)

### コールグラフ解析
- **ファイルグラフ**: 現在のファイル内の全関数を解析し、コール関係を可視化
- **関数グラフ**: カーソル位置の関数を起点に BFS で N ホップ展開
- **ワークスペースグラフ**: 複数の C/C++ ソースファイルをまたいだ横断解析
- **フォルダグラフ**: 選択したフォルダ内の全 C/C++ ファイルを解析
- **デュアルバックエンド対応**:
  - **LSP** — clangd / C/C++ 拡張機能を使用。型解析込みの高精度解析。LSP インデックスが必要。
  - **gtags** — GNU GLOBAL を使用。LSP 不要で高速。大規模プロジェクトに適する。

### インタラクティブグラフ表示
- ノードクリックで caller（緑）と callee（橙）をハイライト
- **ホップフィルタ**: 選択ノードから N ホップ以内のノードのみ表示
- **検索ボックス**: 関数名でフィルタ（Enter でフォーカス移動、Esc でリセット）
- **ソースコードパネル**: ソースをインライン表示してエディタへジャンプ
- **ファイル凡例**: ファイル単位の色分け表示
- **文字サイズ調整**
- **コントロールパネル折りたたみ**: パネルを非表示にしてグラフ表示領域を最大化
- **HTML エクスポート**: スタンドアロン HTML として保存・共有

---

## インストール方法

### Visual Studio Code Marketplace
https://marketplace.visualstudio.com/items?itemName=uta-orange-1214.call-atlas

### 手動インストール
1. このリポジトリをクローンまたはダウンロード
2. `npm install` で依存パッケージをインストール
3. `npm run compile` でビルド
4. `vsce package` で `.vsix` ファイルを作成
5. VS Code で「拡張機能」→「…」→「VSIX からインストール」を選択

---

## 使い方

### 基本的な使い方
1. C/C++ ファイルをエディタで開く
2. 右クリックメニュー or コマンドパレット（`Ctrl+Shift+P`）から実行
3. コマンドを選択後、**バックエンド**（LSP または gtags）と**出力モード**（WebView または HTML ファイル）を選択

### コマンド一覧
| コマンド | 説明 |
|---------|------|
| `Call Atlas: Analyze Workspace` | ワークスペース全体を横断解析 |
| `Call Atlas: Analyze Folder` | 選択フォルダ内の全 C/C++ ファイルを解析 |
| `Call Atlas: Show File Call Graph` | ファイル内の全関数を解析 |
| `Call Atlas: Show Function Graph (BFS)` | カーソル位置の関数から BFS で展開 |
| `Call Atlas: Show Path-Through Graph` | カーソル位置の関数を中心に双方向グラフを表示（LSP・gtags 両対応） |

### キーバインド
| 機能 | キー |
|------|------|
| Analyze Workspace | `Ctrl+Alt+W` |
| Analyze Folder | `Ctrl+Alt+L` |
| Show File Call Graph | `Ctrl+Alt+M` |
| Show Function Graph  | `Ctrl+Alt+F` |
| Show Path-Through Graph | `Ctrl+Alt+P` |

### グラフの操作方法
| 操作 | 内容 |
|------|------|
| ノードクリック | caller（緑）と callee（橙）をハイライト |
| Ctrl / Cmd + クリック | エディタのソースへジャンプ |
| ホップ数ボタン（1 / 2 / 3 / All） | 選択ノードから N ホップ以内のみ表示 |
| 🔍 検索ボックス | 関数名でフィルタ（Enter で次のヒットへ移動、Shift+Enter で前へ、Esc でリセット） |
| ソースコードパネル チェックボックス | 右パネルを表示・非表示 |
| ▼ / ▶ トグルボタン | コントロールパネルを折りたたむ・展開する |
| ダブルクリック / Esc | 選択解除・リセット |
| Ctrl + ホイール | ズーム |
| Shift + ホイール | 横スクロール |
| ホイール | 縦スクロール |

---

## 設定

### 主な設定項目

#### 解析設定
- `callatlas.defaultBackend`: コールグラフ解析のデフォルトバックエンド
  - `lsp`：LSP（clangd / C/C++ 拡張）を使用 — 高精度
  - `gtags`：GNU GLOBAL（gtags）を使用 — 高速、LSP 不要
  - デフォルト: `ask`
- `callatlas.maxHops`: Function Graph / Path-Through Graph の BFS 最大ホップ数
  - デフォルト: `0`（無制限）。グラフが重くなりすぎる場合は `1` 以上を設定すると深さを制限できます。
- `callatlas.gtagsUpdateInterval`: gtags DB(`global -u`)の自動更新間隔
  - `always` / `5` / `30` / `60`（分） / `off`
  - デフォルト: `5`。`off` にすると Call Atlas は `global -u` を自動実行しなくなります(巨大なツリーで再スキャンが遅い場合、手動で `gtags` を実行する運用向け)。

#### 出力設定
- `callatlas.defaultOutputMode`: デフォルト出力モード
  - `webview`：毎回確認せず常に WebView で開く
  - `html`：毎回確認せず常に HTML として保存する
  - デフォルト: `ask`

#### 表示設定
- `callatlas.warnThreshold`: 解析対象ファイル数がこの値を超えると警告を表示する
  - デフォルト: `30`
- `callatlas.initialControlPanel`: グラフ表示時のコントロールパネルの初期表示状態
  - `expanded`：コントロールパネルを表示する（デフォルト）
  - `collapsed`：コントロールパネルを非表示にしてグラフ表示領域を最大化する

### キャッシュについて
- **LSPの結果はキャッシュしません** — 生きたドキュメントバッファの内容と、言語サーバーの
  現在のインデックス状態(それ自体が古くなりうる。下記インデックスに関する注記も参照)に
  依存する結果のため、毎回言語サーバーへ問い合わせます。
- **gtagsの結果は5分間キャッシュされます**(ファイル/関数/ワークスペース単位、バックエンド別)。
  ノード0件や警告付きの結果はキャッシュされません。また `File`/`Function`/`Path-Through` Graph の
  キャッシュは、ワークスペース内のいずれかのC/C++ファイルが変更されるたびにクリアされます
  (グラフは元になったファイル以外にも依存しうるため)。解析元のドキュメントに未保存の
  編集がある間もキャッシュは使われません。
- 古い結果を見ている疑いがある場合、最も確実なのはファイルを保存してから
  (関連キャッシュが無効化されます)再解析することです。

---

## 必要なもの

- VS Code 1.85 以上
- **LSP バックエンド使用時** — 以下のいずれかの C/C++ 言語サーバー拡張機能:
  - **clangd** (`llvm-vs-code-extensions.vscode-clangd`) ← **強く推奨**
  - **C/C++** (`ms-vscode.cpptools`) — ⚠️ 既知の問題: cpptoolsのCall Hierarchy機能は、「呼び出し元(Callers Of)」の展開を複数同時に行うと、一部の呼び出し元エッジを無言で取りこぼすことがあります([microsoft/vscode-cpptools#11747](https://github.com/microsoft/vscode-cpptools/issues/11747)、本稿執筆時点でopen)。多ホップに展開するFunction Graph / Path-Through Graphで特に影響が出やすいです。深い・広いグラフを正確に見たい場合はclangdの使用を推奨します。
- **gtags バックエンド使用時** — GNU GLOBAL のインストールが必要（PATH に追加すること）:
  - macOS: `brew install global`
  - Ubuntu/Debian: `sudo apt install global`
  - Windows: [GNU GLOBAL 公式サイト](https://www.gnu.org/software/global/) からダウンロード
  - Call Atlas は gtags で解析した各ワークスペースフォルダの直下に `GTAGS` / `GRTAGS` / `GPATH`
    を自動生成し、`global -u`(`callatlas.gtagsUpdateInterval`参照)で更新します。
    **この3ファイルを `.gitignore` に追加してください**(既存の除外ルールで
    カバーされていない場合)。
  - gtags はこれらのファイルを置く場所が必要なため、ワークスペースフォルダ
    (`ファイル > フォルダーを開く...`)が開かれていることが必須です。LSPバックエンドには
    この制約はありません。

> **解析対象になるファイルについて**: Call Atlas はワークスペース内のどこにあっても
> `node_modules`、`build`、`dist`、`out`、`.git`、`CMakeFiles`、`_build`、`_deps`、
> `cmake-build-debug`、`cmake-build-release`、`.cache`、`.ccls-cache`、`vendor`、`.deps`
> といった、生成物・ベンダー系ディレクトリを解析対象から除外します。そのため
> `src/build/` のようにソースツリーの一部として使っているディレクトリも除外されます。
> 現時点ではこの一覧をユーザー側でカスタマイズすることはできません。

> **clangd を使う場合の注意**: プロジェクトルートに `compile_commands.json` があると精度が大幅に向上します。
> CMake なら `cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`、Bear なら `bear -- make` で生成できます。

### リモート開発（SSH / Dev Containers / Codespaces / WSL）

Call Atlas はワークスペースがあるマシン側で動作するため、リモートウィンドウでも利用できます。
ただし、拡張機能と使用するツールは**リモート側**に必要です。

- 拡張機能をリモート側にもインストールしてください（拡張機能ページの「SSH: <ホスト> にインストール」
  「WSL: <ディストリ> にインストール」を使用）。Dev Containers / Codespaces では、
  `devcontainer.json` の `customizations.vscode.extensions` に `uta-orange-1214.call-atlas` を追加します。
- リモートマシン（またはコンテナ）に clangd（LSP バックエンド）や GNU GLOBAL（gtags バックエンド）を
  インストールしてください（例: Dockerfile で `apt install global`）。
- Windows 側の VS Code で `\\wsl$\...` 経由で WSL のフォルダを開く使い方は非対応です。
  WSL 拡張機能（Remote - WSL）を使用してください。
- VS Code for the Web（vscode.dev / github.dev）と仮想ワークスペースは非対応です
  （実ファイルシステムとローカルにインストールされたツールが必要なため）。

### Windows での注意

- GNU GLOBAL のインストール後、`gtags.exe` / `global.exe` のあるフォルダを `PATH` に追加し、
  **VS Code を再起動**してください。統合ターミナルで `gtags --version` が通るか確認できます。
  起動できるのは `.exe` のみです（`.cmd` などのラッパースクリプトは不可）。
- ネイティブWindows環境はLinux/macOS/WSLほど十分に検証できていません。想定外の挙動があれば
  フィードバックをお待ちしています。

---

## トラブルシューティング

### LSP: シンボルが見つからない
1. clangd または C/C++ 拡張機能がインストール・有効化されているか確認
2. バックグラウンドインデックスの完了を待つ（ステータスバーを確認）
3. clangd 使用時: プロジェクトルートに `compile_commands.json` があるか確認

### gtags: タグが見つからない
1. `gtags` が PATH に存在するか確認: `gtags --version`
2. プロジェクトルートに `GTAGS`・`GRTAGS`・`GPATH` ファイルが存在するか確認
3. プロジェクトルートで `gtags` を手動実行してデータベースを生成

### グラフが空になる
- ファイルに言語サーバーが認識できる C/C++ 関数定義が含まれているか確認
- gtags バックエンドの場合、プロジェクトルートが VS Code のワークスペースフォルダとして開かれているか確認

### シンボリックリンクが辿られない
- `Analyze Folder` および `Analyze Workspace` はシンボリックリンクを意図的に辿りません。
  プロジェクトがシンボリックリンクで繋がれたソースディレクトリに依存している場合は、
  リンク先の実ディレクトリをワークスペースフォルダとして追加してください。

### Function Graph (BFS) の動作がバックエンドで異なる
- LSP・gtags 両バックエンドとも、`Show Function Graph (BFS)` コマンドは **下方向 BFS のみ**（callee 方向）です。
- 上下双方向グラフ（caller と callee の両方）が必要な場合は、`Show Path-Through Graph` コマンドを使用してください（LSP・gtags 両バックエンド対応）。
- **カーソル位置の扱いも異なります**: LSPバックエンドはカーソルが関数名そのものの上にある必要があります(VSCodeのCall Hierarchy機能の制約)。gtagsは関数本体内であればどの行でも構いません — 行範囲からカーソルを囲む関数を判定します。

### LSP (cpptools): 一部の呼び出し元エッジが欠落する
- LSPバックエンドとして **C/C++ 拡張機能(cpptools)** を使っている場合、これは Call Atlas 側ではなく **cpptools 側の既知バグ**です。cpptools の Call Hierarchy 機能は、「呼び出し元(Callers Of)」の問い合わせを複数同時に展開すると、一部が無言で空の結果を返すことがあります([microsoft/vscode-cpptools#11747](https://github.com/microsoft/vscode-cpptools/issues/11747))。多ホップを同時展開する Function Graph / Path-Through Graph で発生しやすいです。
- 検証では **clangd** 拡張機能に切り替えることでこの問題は解消しました。cpptools を使い続ける場合、深いグラフの結果は欠落している可能性がある前提で見てください。

### LSP: プロジェクトを開いた直後は他ファイルへのエッジが欠けることがある
- これは **clangd・cpptools どちらでも**起こりえます（cpptools固有ではありません）。両言語サーバーともワークスペースのバックグラウンドインデックスを構築しており、まだインデックスが完了していないファイルに対する Call Hierarchy の問い合わせは、結果が不完全なまま無言で返ってくることがあります。
- 特に「呼び出し先がすべて他ファイルの関数」であるような関数（例: 各モジュールの `_init()` をまとめて呼ぶ初期化関数）で気づきやすいです。すべてのエッジがファイルをまたいだ名前解決に依存するためです。
- 解析を実行する前に、言語サーバーのインデックス完了を待ってください（ステータスバーで確認できます。clangdは「indexing...」、cpptoolsも同様の進捗表示が出ます）。早すぎるタイミングで解析してしまった場合は、インデックス完了後に再実行してください。これは Call Atlas 側のバグではなく、LSPサーバーのインデックス構築方式に起因するものです。

---

## 既知の制限事項

- **C++のオーバーロード/同名メソッド**: 関数はファイル+ベース名(引数の型を除く)でインデックスされるため、1ファイル内のオーバーロード関数や、異なるクラスの同名メソッドが、まれに別のノードへ誤って解決されることがあります。実際のC++プロジェクトでの検証はまだできていないため、C++での結果は特に注意して見てください。
- **gtagsの関数終端の近似**: gtagsは中括弧を解析しないため、関数の終端を「ファイル内の次の関数の開始位置」(最後の関数はファイル末尾)で近似しています。関数本体の実際の終わりから次の関数の開始までの間にあるもの(`static const struct ops my_ops = { .open = my_open, ... };` のような関数ポインタテーブルや、末尾のマクロなど)が、その関数からの呼び出しとして誤ってカウントされることがあります。gtagsバックエンドではLSPに出ない余分なエッジが出ることがある、という既知の原因です。
- **gtagsの呼び出し検出は正規表現ベースで、実際のパーサーではありません**: `dev->init()` のようなメンバ呼び出しを、`init`という単独の関数への呼び出しと誤認識することがあります。また C++14以降の数値区切り(`1'000'000`)については、`'`以降をその行の末尾まで読み飛ばしてしまうため、同じ行の検出精度が落ちることがあります。これらはgtagsの軽量なテキストベース方式に起因する制限です。
- **デフォルトのキーバインドが競合する場合があります**: `Ctrl+Alt+W/L/M/F/P` はLinuxのデスクトップ環境のショートカットや、一部の非US配列キーボードのAltGr文字と衝突することがあります。動作しない場合は `ファイル > 基本設定 > キーボードショートカット` から「Call Atlas」で検索して再割り当てしてください。
- **Workspace/Folder解析の範囲がバックエンドで異なります**: gtagsは初期グラフ構築後、ワークスペース全体に対して上方向(呼び出し元)を無制限に展開しますが、LSPはファイルごとに外向き1ホップのみ展開します。意図した挙動です(gtagsは高速なのでこれを積極的に行っています)が、大規模プロジェクトではグラフが目に見えて大きくなることがあります。
- **gtags: フォルダ名に空白を含む場合**: 名前に空白を含むサブフォルダ(例: `src/My Module/`)内のタグは取得できず、解析対象から外れます(`global -x` の出力を空白で分割しているため)。(ワークスペースのルートパス自体に空白があっても影響しません。)フォルダ名を変更するか、LSPバックエンドを使用してください。この状況が発生した場合、Call Atlasは警告(`[gtags] Skipped N reference(s)...`)を表示するようになったため、無言のデータ欠落ではなく警告として気づけます。
- **ソースの文字コード**: ソースパネルはファイルをUTF-8として読み込みます。Shift_JIS / EUC-JPのファイルではコメントや文字列が文字化けして表示されることがあります(解析結果の関数名・エッジには影響しません)。
- **グラフサイズの安全弁がありません**: ノード数にもBFSの深さ(File Graph、またはデフォルト(`0`)のままの`callatlas.maxHops`でのFunction/Path-Through Graph)にも上限がありません。多くの関数から呼ばれる「ハブ」関数(ログ出力・アサーション・メモリ確保など)があると、プロジェクトの大部分が1つのグラフに取り込まれ、構築に時間がかかり、開いても読みにくくなることがあります。該当する場合は `callatlas.maxHops` を小さい値に設定するか、ワークスペース全体ではなくより小さいFile/Folder単位で解析してください。進行中の解析は、ステータスバーの Call Atlas 項目(ホバーして表示されるツールチップ内の Cancel リンク)からいつでもキャンセルできます。

---

## ライセンス

このプロジェクトのライセンスは MIT です。（LICENSE ファイル参照）
自由に利用・改変・再配布が可能です。

---

## 作者

uta

---

## リポジトリ

https://github.com/uta1214/call-atlas