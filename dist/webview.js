// src/webview.js
(function () {
  'use strict';

  var isVscode = false;
  var vscode;
  try {
    vscode   = acquireVsCodeApi();
    isVscode = true;
  } catch (e) {
    vscode = { postMessage: function () {} };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // グローバル状態
  // ─────────────────────────────────────────────────────────────────────────

  var DEFAULT_FONT_SIZE = 11;

  // hierarchical レイアウトのノード数上限。
  // vis-network の hierarchical + sortMethod:'directed' はトポロジカルソートを
  //   内部で行うため、この閾値を超えると計算が破綻して全ノードが (0,0) に集まり
  //   白紙グラフになる。閾値を超えた場合は physics ベースのレイアウトにフォールバック。
  var HIERARCHICAL_THRESHOLD = 150;
  // ここから HIERARCHICAL_LIGHT_THRESHOLD までは hierarchical を維持しつつ
  // blockShifting / edgeMinimization / parentCentralization という重い最適化だけを
  // 切った「軽量 hierarchical」を使う。sortMethod は 'hubsize' のまま変えない
  // (上の 'directed' 崩壊のコメント通り、sortMethod を変えると閾値内でも
  //  壊れるリスクがあるため)。
  // この値は未検証の目安。実際の環境で 150〜1500 あたりの規模をいくつか試して、
  // 崩れる/重すぎるようなら調整すること。
  var HIERARCHICAL_LIGHT_THRESHOLD = 800;
  var network  = null;
  var nodes    = null;
  var edges    = null;

  // ─────────────────────────────────────────────────────────────────────────
  // レイアウト tier 判定と vis-network オプション組み立て (共通化)
  // ─────────────────────────────────────────────────────────────────────────
  function getLayoutTier(n) {
    if (n <= HIERARCHICAL_THRESHOLD) return 'full';
    if (n <= HIERARCHICAL_LIGHT_THRESHOLD) return 'light';
    return 'physics';
  }

  function buildLayoutOptions(tier) {
    if (tier === 'full') {
      return {
        layout: { hierarchical: {
          enabled: true, direction: 'LR', sortMethod: 'hubsize',
          levelSeparation: 220, nodeSpacing: 70, treeSpacing: 130,
          blockShifting: true, edgeMinimization: true, parentCentralization: true
        }},
        physics: { enabled: false }
      };
    }
    if (tier === 'light') {
      return {
        layout: { hierarchical: {
          enabled: true, direction: 'LR', sortMethod: 'hubsize',
          levelSeparation: 220, nodeSpacing: 60, treeSpacing: 100,
          blockShifting: false, edgeMinimization: false, parentCentralization: false
        }},
        physics: { enabled: false }
      };
    }
    // 'physics': x は bfsLevel から renderGraph 側で固定済み (fixed.x = true)。
    // physics は同じ x 列内での y 方向の重なり解消だけを担当する。
    return {
      layout: { hierarchical: { enabled: false } },
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -50, springLength: 80,
          springConstant: 0.05, avoidOverlap: 0.3
        },
        stabilization: { iterations: 200, fit: true },
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // カラーテーマ (callatlas.colorTheme: auto/light/dark)
  // ─────────────────────────────────────────────────────────────────────────
  // ノードは shape:'dot' のため、ラベル文字はノードの塗り色の中ではなく
  // キャンバス背景の上に描画される。そのため「キャンバスの明暗」に応じて
  // ラベル文字色・非強調(dimmed)ノードの色・エッジのハイライト/薄色を
  // 切り替える必要がある。選択/callee/callerの塗り色(アクセントカラー)自体は
  // どちらの背景でも視認性を保てるため、ライト/ダークで変更しない。
  var THEMES = {
    light: {
      bg:             '#f8f9fa',
      nodeFontDefault:'#2d3436',
      selectedFont:   '#1a3d5c',
      calleeFont:     '#6d2b1a',
      callerFont:     '#003d33',
      unrelatedBg:    '#ececec', unrelatedBorder: '#cccccc', unrelatedFont: '#bbbbbb',
      hopHiddenBg:    '#f0f0f0', hopHiddenBorder: '#e0e0e0', hopHiddenFont: '#e0e0e0',
      searchDimFont:  '#dddddd',
      edgeNormal:      '#aaaaaa',
      edgeHighlighted: '#636e72',
      edgeDimmed:      '#e8e8e8',
      edgeHopDimmed:   '#eeeeee',
    },
    dark: {
      bg:             '#1e1e1e',
      nodeFontDefault:'#e6e6e6',
      selectedFont:   '#cfe6ff',
      calleeFont:     '#ffd9cc',
      callerFont:     '#bdf5e0',
      unrelatedBg:    '#3a3a3a', unrelatedBorder: '#4d4d4d', unrelatedFont: '#5a5a5a',
      hopHiddenBg:    '#2a2a2a', hopHiddenBorder: '#383838', hopHiddenFont: '#333333',
      searchDimFont:  '#3a3a3a',
      edgeNormal:      '#aaaaaa',
      edgeHighlighted: '#b0b6bc',
      edgeDimmed:      '#333333',
      edgeHopDimmed:   '#2e2e2e',
    }
  };
  var currentThemeMode = 'light'; // 'light' | 'dark' (解決済みの実効テーマ)
  function T() { return THEMES[currentThemeMode]; }

  function detectPrefersDarkOS() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  // VS Code Webview には <body> に vscode-light / vscode-dark / vscode-high-contrast
  // のいずれかのクラスが付与され、テーマ切り替え時にも自動で更新される。
  // スタンドアロンHTML書き出し版にはこのクラスが無いため OS の prefers-color-scheme を見る。
  function detectAutoIsDark() {
    var cls = document.body ? document.body.className : '';
    if (isVscode) {
      if (/vscode-dark|vscode-high-contrast(?!-light)/.test(cls)) return true;
      if (/vscode-light|vscode-high-contrast-light/.test(cls)) return false;
    }
    return detectPrefersDarkOS();
  }

  var colorThemeSetting  = 'auto';
  var themeObserverStarted = false;
  function applyColorTheme(setting, opts) {
    colorThemeSetting = setting || 'auto';
    var isDark = colorThemeSetting === 'dark' ? true
               : colorThemeSetting === 'light' ? false
               : detectAutoIsDark();
    var changed = (isDark ? 'dark' : 'light') !== currentThemeMode;
    currentThemeMode = isDark ? 'dark' : 'light';
    document.documentElement.classList.toggle('atlas-dark', isDark);
    // auto設定時のみ、VS Code側のテーマ切り替えをライブ監視する(1回だけ登録)。
    if (isVscode && document.body && colorThemeSetting === 'auto' && !themeObserverStarted) {
      themeObserverStarted = true;
      new MutationObserver(function () {
        if (colorThemeSetting !== 'auto') return;
        applyColorTheme('auto');
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    // 再描画: 既にグラフが読み込まれた後のライブなテーマ切り替えでは、
    // ノード/エッジの色を新テーマで塗り直す。
    // Bug A修正: resetAll() は検索/選択/Hop filterの状態まで無条件にクリアしてしまうため、
    // 「今の状態を保ったまま色だけ塗り直す」repaintTheme() に差し替える。
    if (changed && !(opts && opts.skipRepaint) && nodes) {
      repaintTheme();
    }
  }

  // グラフデータ('graphData'/INITIAL_GRAPH_DATA)到着前の一瞬(ローディング画面)にも
  // 正しいテーマで表示するため、webviewPanel.ts が早期に埋め込む
  // window.__CALLATLAS_COLOR_THEME__ を使って先にテーマだけ適用しておく。
  // (スタンドアロン版ではこのグローバル変数は無いので 'auto' 扱いになり、
  //  直後の renderGraph(INITIAL_GRAPH_DATA) で確定値に上書きされる)
  applyColorTheme(
    typeof window.__CALLATLAS_COLOR_THEME__ !== 'undefined' ? window.__CALLATLAS_COLOR_THEME__ : 'auto',
    { skipRepaint: true }
  );

  var nodeInfoMap          = {};   // id → { file, line, scopeEnd, label, labelFull, source? }
  var showFullSig          = false; // 引数表示トグル (sig-toggle)。デフォルトはオフ。
  var defaultNodeColors    = {};
  var canvasFontSize       = DEFAULT_FONT_SIZE;
  var currentNode          = null;
  var connectedEdgesOfNode = new Set();
  var _hadSelection        = false; // ノードが一度でも選択されたかを追跡（エッジリセット最適化用）
  var currentSourceNodeId  = null;
  var pendingSourceNodeId  = null; // requestSource 送信済みで応答待ちの nodeId

  // ─────────────────────────────────────────────────────────────────────────
  // Extension → WebView メッセージ
  // ─────────────────────────────────────────────────────────────────────────

  window.addEventListener('message', function (e) {
    var msg = e.data;
    switch (msg.type) {
      case 'loading':    showLoading(msg.fileName);          break;
      case 'graphData':  renderGraph(msg);                   break;
      case 'error':      hideLoading(); showErrorInView(msg.message); break;
      case 'cancelled':  hideLoading(); showCancelledInView();        break;
      case 'sourceData':
        // requestSource の応答: source を nodeInfoMap にキャッシュして表示
        if (nodeInfoMap[msg.nodeId]) {
          nodeInfoMap[msg.nodeId].source = msg.source;
        }
        // 現在 pending 中のリクエストと一致する場合のみクリアする。
        // 無条件でクリアすると、A→B と連続クリックした際に遅れて届いた
        // A の応答が B の pending 状態を誤って解除してしまい、
        // B の応答が届く前に A への再クリックで重複リクエストが飛びうる。
        if (msg.nodeId === pendingSourceNodeId) pendingSourceNodeId = null;
        // 現在表示中のノードと一致する場合のみ再描画
        if (msg.nodeId === currentSourceNodeId) _renderSourceContent(msg.nodeId);
        break;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ローディング / エラー
  // ─────────────────────────────────────────────────────────────────────────

  function showLoading(fileName) {
    document.getElementById('loading-overlay').style.display = 'flex';
    document.getElementById('loading-msg').textContent =
      fileName ? ('"' + fileName + '"  Analyzing...') : 'Analyzing...';
  }

  function hideLoading() {
    document.getElementById('loading-overlay').style.display = 'none';
  }

  // escapeHtml を5文字エスケープ（& < > " '）に統一し、
  // 属性値に使っても XSS にならないようにする。
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  // HTML 属性値（title 等）のエスケープ（escapeHtml と同一）
  var escapeAttr = escapeHtml;

  // A1修正: #network の innerHTML を書き換える前に、既存の vis.Network インスタンスを
  // 破棄して network/nodes/edges を null に戻す。これをしないと、次回 renderGraph() が
  // 「network は non-null だから既存インスタンスを再利用する」分岐に入ってしまい、
  // 既に innerHTML 書き換えで DOM から切り離された canvas へ描画し続けて何も見えなくなる。
  function destroyNetworkState() {
    if (network) { try { network.destroy(); } catch (e) { /* 既に破棄済み等は無視 */ } }
    network = null;
    nodes   = null;
    edges   = null;
  }

  function showErrorInView(msg) {
    destroyNetworkState();
    document.getElementById('network').innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;' +
      'height:100%;flex-direction:column;gap:12px;padding:40px;">' +
      '<span style="font-size:36px;">⚠️</span>' +
      '<pre style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;' +
      'padding:16px;max-width:620px;white-space:pre-wrap;color:#856404;' +
      'font-family:monospace;font-size:12px;line-height:1.7;">' +
      escapeHtml(msg) + '</pre>' +
      '<p style="font-size:11px;color:#b2bec3;font-family:monospace;">' +
      'Check that clangd / gtags is enabled</p>' +
      '</div>';
  }

  // ユーザーによるキャンセル専用。showErrorInView と違い、警告アイコンや
  // 「clangd/gtagsを確認して」といった文言を出さない(失敗ではないため)。
  function showCancelledInView() {
    destroyNetworkState();
    document.getElementById('network').innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;' +
      'height:100%;flex-direction:column;gap:10px;padding:40px;color:#b2bec3;' +
      'font-family:monospace;">' +
      '<span style="font-size:28px;">⏹</span>' +
      '<p style="font-size:13px;">Analysis cancelled.</p>' +
      '</div>';
  }

  // A1修正(防御策): network が non-null でも、その canvas が既に DOM から
  // 切り離されている(#network の innerHTML が別経路で書き換わった等)場合は
  // 再利用せず作り直す。vis-network 内部の network.body.container を参照するため
  // try/catch で保護し、参照できない場合は安全側(再利用しない=false)に倒す。
  function isNetworkAttached() {
    // R2修正: network.body.container は vis.Network のコンストラクタに渡した
    // #network 要素そのもの(参照)であり、innerHTML を書き換えても要素自体は
    // DOMに残り続けるため isConnected は常に true になり判定になっていなかった。
    // 実際に切り離されるのは vis-network が内部で作る描画用フレーム
    // (class="vis-network" のdiv、vis-network 9.1.13 のソースで確認済み)なので、
    // それが #network の子として存在するかで判定する。
    try {
      var container = document.getElementById('network');
      return !!(network && container && container.querySelector('.vis-network'));
    } catch (e) { return false; }
  }



  // ─────────────────────────────────────────────────────────────────────────
  // グラフ描画
  // ─────────────────────────────────────────────────────────────────────────

  function renderGraph(msg) {
    // colorTheme(auto/light/dark)を確定させる。ここは WebView 版('graphData'メッセージ)・
    // スタンドアロン版(INITIAL_GRAPH_DATA)どちらの経路でも通る唯一の入口なので、
    // ここで一度だけ解決すれば以降の全ノード/エッジ描画に反映される。
    // まだ nodes が無い(初回)ので resetAll() による再描画は不要 → skipRepaint。
    applyColorTheme(msg.colorTheme, { skipRepaint: true });

    nodeInfoMap = {};
    msg.nodes.forEach(function (n) {
      nodeInfoMap[n.id] = {
        file:      n.file,
        line:      n.line,
        scopeEnd:  n.scopeEnd,
        label:     n.label,
        labelFull: n.labelFull || n.label,
        source:    n.source || null, // スタンドアロン HTML 時のみ設定済み、通常は null
      };
    });

    // A5修正: 自己ループ(e.from === e.to)は「外部からの入力」ではないので入次数から除外する。
    // 除外しないと純粋な自己再帰関数(f→f)の入次数が1になってしまい root として検出されず、
    // 相互再帰グループ全体が「root 0件」と判定されて、後段の孤立ノード救済で
    // 全ノードが level=0 に潰れる原因になっていた。
    var inDeg = {};
    msg.edges.forEach(function (e) {
      if (e.from !== e.to) inDeg[e.to] = (inDeg[e.to] || 0) + 1;
    });

    // ─── BFS 最短パスレベル計算 ───────────────────────────────────────────────
    // vis-network のデフォルト動作 (longest-path) だと、同じ caller から呼ばれた
    // 兄弟ノードが異なる列に配置される問題がある。
    // 各ノードに level プロパティ (= root からの最短ホップ数) を明示することで
    // vis-network に対してレベルを強制し、兄弟を同列に揃える。
    //
    // 例:  main → A → X → Z
    //           → B ──────↗   (B の level は A と同じ 1 に固定)
    //           → C ──────↗   (C の level は A と同じ 1 に固定)
    //
    // 手順:
    //   1. 入次数 0 のノードを root として level = 0 に設定し BFS で伝播
    //   2. まだ level が付いていないノードが残る場合(root を持たない循環グループ)、
    //      その中で msg.nodes の並び順で先頭の未訪問ノードを新たな種(level = 0)にして
    //      再度 BFS で伝播する。これを全ノードに level が付くまで繰り返す。
    //      (既に level が確定したノードは上書きしない)
    var bfsLevel = {};
    var adjOut = {};   // nodeId → [隣接 to の nodeId]
    msg.nodes.forEach(function (n) { adjOut[n.id] = []; });
    msg.edges.forEach(function (e) {
      if (adjOut[e.from]) adjOut[e.from].push(e.to);
    });

    // サイクルグラフで bfsLevel の更新が収束するまで同じノードが再度キューに積まれ
    // O(N²) になる問題を防ぐため、inQueue セットで重複追加を抑制する。
    // サイクルが多数ある場合のキュー膨張を防ぐため上限も設ける(種ごとにリセット)。
    var BFS_QUEUE_LIMIT = msg.nodes.length * 10;

    function propagateLevels(seedIds, locked) {
      var queue   = seedIds.slice();
      var inQueue = new Set(queue);
      var qi = 0;
      while (qi < queue.length) {
        var cur = queue[qi++];
        inQueue.delete(cur);
        var nextLevel = bfsLevel[cur] + 1;
        (adjOut[cur] || []).forEach(function (to) {
          // R3修正: 呼び出し元(孤立ノード救済フェーズ)から渡された「確定済み」
          // ノード集合に含まれる場合は動かさない。これが無いと、root を持たない
          // 循環グループ(救済フェーズで後から seed される)が、既に正しく配置済みの
          // ノードへ辺を持つ場合に、その確定済みノードの level を引き下げてしまい、
          // 辺の向きが直感に反する見た目になっていた。
          if (locked && locked[to]) return;
          // 未訪問 OR より浅いパスが見つかった場合にのみ更新
          if (bfsLevel[to] === undefined || bfsLevel[to] > nextLevel) {
            bfsLevel[to] = nextLevel;
            if (!inQueue.has(to) && queue.length < BFS_QUEUE_LIMIT) {
              inQueue.add(to);
              queue.push(to); // 更新があったので再伝播
            }
          }
        });
      }
    }

    // root = 入次数 0 のノード
    var roots = [];
    msg.nodes.forEach(function (n) {
      if (!inDeg[n.id]) {           // 入次数 0 (自己ループ除外後)
        bfsLevel[n.id] = 0;
        roots.push(n.id);
      }
    });
    propagateLevels(roots);

    // 孤立ノード救済: root(入次数0のノード)が無い循環グループが残っている場合、
    // その中で先頭の未訪問ノードだけを level=0 の種にして BFS をやり直す。
    // 全ノードを一括で level=0 にリセットすると「全員が既に0」で
    // 更新条件(bfsLevel[to] > nextLevel = 0 > 1 = false)を満たせず一切伝播が起きず、
    // グラフ全体が1列に潰れてしまっていた。
    // R3修正: この時点で既に level が付いているノードは「確定済み」として
    // locked に入れ、propagateLevels に渡す。渡さないと、後から seed される
    // 循環グループが確定済みノードへ辺を持つ場合に、そのノードの level を
    // 引き下げてしまうことがあった(コメント「既に確定したノードは上書きしない」
    // という意図と実際の挙動が一致していなかった)。
    msg.nodes.forEach(function (n) {
      if (bfsLevel[n.id] === undefined) {
        var locked = {};
        Object.keys(bfsLevel).forEach(function (id) { locked[id] = true; });
        bfsLevel[n.id] = 0;
        propagateLevels([n.id], locked);
      }
    });

    // ─── level 内の縦順を固定 (order) ───────────────────────────────────────
    // Same level nodes are sorted by file name then line number so the layout
    // is deterministic across renders, and functions in the same file cluster together.
    var levelGroups = {};
    msg.nodes.forEach(function (n) {
      var lv = bfsLevel[n.id] !== undefined ? bfsLevel[n.id] : 0;
      if (!levelGroups[lv]) levelGroups[lv] = [];
      levelGroups[lv].push(n);
    });
    var nodeOrder = {};
    Object.keys(levelGroups).forEach(function (lv) {
      levelGroups[lv]
        .slice()
        .sort(function (a, b) {
          var fi = (nodeInfoMap[a.id] ? nodeInfoMap[a.id].file : '') || '';
          var fj = (nodeInfoMap[b.id] ? nodeInfoMap[b.id].file : '') || '';
          if (fi !== fj) return fi < fj ? -1 : 1;
          var li = (nodeInfoMap[a.id] ? nodeInfoMap[a.id].line : 0) || 0;
          var lj = (nodeInfoMap[b.id] ? nodeInfoMap[b.id].line : 0) || 0;
          return li - lj;
        })
        .forEach(function (n, i) { nodeOrder[n.id] = i; });
    });
    // ─────────────────────────────────────────────────────────────────────────

    var layoutTier = getLayoutTier(msg.nodes.length);
    // physics tier: x は bfsLevel(=root からのホップ数)で固定し、
    // 「左→右」の流れだけは物理演算下でも必ず保つ。
    // y は level 内の並び順 (nodeOrder) を初期値にして physics に重なり解消させる。
    // 1 レベルに大量のノードが集中すると縦に無限に伸びてしまうため、
    // WRAP_SIZE 件を超えたら同じレベル内で横に折り返して複数列に分ける。
    var X_SPACING = 220, Y_SPACING = 40, WRAP_SIZE = 50, SUBCOL_OFFSET = 40;

    var visNodes = msg.nodes.map(function (n) {
      var vn = {
        id:          n.id,
        label:       getLabel(nodeInfoMap[n.id] || n),
        title:       n.title,
        color:       n.color,
        size:        Math.min(12 + ((inDeg[n.id] || 0) * 3), 40),
        shape:       'dot',
        borderWidth: n.isCurrentFile ? 2 : 1,
        font:        { size: DEFAULT_FONT_SIZE, face: 'monospace', color: T().nodeFontDefault },
        shadow:      { enabled: true, size: 4, x: 2, y: 2, color: 'rgba(0,0,0,0.08)' },
        level:       bfsLevel[n.id]  !== undefined ? bfsLevel[n.id]  : 0,
        order:       nodeOrder[n.id] !== undefined ? nodeOrder[n.id] : 0
      };
      if (layoutTier === 'physics') {
        var subCol = Math.floor(vn.order / WRAP_SIZE);
        vn.x     = vn.level * X_SPACING + subCol * SUBCOL_OFFSET;
        vn.y     = (vn.order % WRAP_SIZE) * Y_SPACING;
        vn.fixed = { x: true, y: false };
      }
      return vn;
    });

    var visEdges = msg.edges.map(function (e, i) {
      return {
        id: i, from: e.from, to: e.to, arrows: 'to',
        color:  { color: T().edgeNormal, hover: T().edgeNormal, highlight: T().edgeNormal },
        width:  1,
        smooth: { enabled: true, type: 'cubicBezier', forceDirection: 'horizontal', roundness: 0.5 }
      };
    });

    // clear の順序は必ず edges → nodes。
    // nodes を先に消すとエッジが存在しないノードを参照する状態になり
    // vis-network が内部エラーで描画を中断するため白紙になる。
    // ノード数に応じてレイアウトを切り替える:
    // hierarchical は大量ノードで破綻するため tier(full/light/physics)で分岐する。
    if (network && isNetworkAttached()) {
      // 前回の stabilize が完了していない状態で再レンダリングが呼ばれた場合、
      // 古いハンドラが先に発火して競合が発生するため stopSimulation() で先に停止させる。
      network.stopSimulation();
      var reOpts = buildLayoutOptions(layoutTier);
      network.setOptions({ layout: reOpts.layout, physics: reOpts.physics });
      edges.clear(); edges.add(visEdges);
      nodes.clear(); nodes.add(visNodes);
      if (layoutTier === 'physics') {
        bindPhysicsProgressHandlers(network);
        network.stabilize(200);
      } else {
        // hierarchical (full/light) モードは physics と対称に fit() を呼んでズーム位置をリセットする
        network.fit();
      }
    } else {
      nodes = new vis.DataSet(visNodes);
      edges = new vis.DataSet(visEdges);
      initNetwork(visNodes.length);
    }

    defaultNodeColors = {};
    nodes.forEach(function (n) {
      // fontColor は全ノード共通のテーマ依存値(per-fileの背景色 color とは違いノード固有
      // ではない)なのでキャッシュしない。参照側は必ず T().nodeFontDefault を直接呼ぶ。
      // (キャッシュすると、グラフ構築時点のテーマ色のまま固まり、ライブテーマ切替後に
      //  古いテーマの文字色で塗り直されてしまうバグの原因になっていた)
      defaultNodeColors[n.id] = {
        color: JSON.parse(JSON.stringify(n.color || {}))
      };
    });

    renderLegend(msg.fileLegend);
    closeWarningModal(); // 再解析時に前回の警告モーダルが残らないようにする

    var errNote = (msg.errors && msg.errors.length > 0)
      ? ' ⚠️ warnings: ' + msg.errors.length : '';
    var layoutNote =
      layoutTier === 'full'   ? ' [hierarchical]' :
      layoutTier === 'light'  ? ' [hierarchical-light]' :
                                 ' [physics]';
    var buildInfoEl = document.getElementById('build-info');
    buildInfoEl.textContent =
      'Nodes: ' + msg.nodes.length + ' / Edges: ' + msg.edges.length +
      ' / ' + msg.buildTimeMs + 'ms' + layoutNote + errNote;

    // 警告がある場合: hover で詳細を表示、クリックでモーダル表示
    // alert() は VSCode webview の sandboxed iframe 内では動作しないため
    // (allow-modals が付与されていない)、自前の DOM モーダルを使う。
    if (msg.errors && msg.errors.length > 0) {
      buildInfoEl.style.cursor  = 'pointer';
      buildInfoEl.style.color   = '#e17055';
      // C1修正: .title はDOMプロパティへの代入であり、innerHTMLのようにHTMLとして
      // 解釈されるわけではない。escapeAttr(HTMLエンティティ変換)をかけると
      // ブラウザはそのままの文字列("&amp;"等)を表示してしまう(二重エスケープ)。
      buildInfoEl.title = msg.errors.join('\n');
      buildInfoEl.onclick = function () {
        openWarningModal(msg.errors);
      };
    } else {
      buildInfoEl.style.cursor  = '';
      buildInfoEl.style.color   = '';
      buildInfoEl.title = '';
      buildInfoEl.onclick = null;
    }

    resetAll();

    // 設定値 callatlas.initialControlPanel に従って初期パネル状態を適用する。
    // グラフ表示のたびに設定値を参照するため、再描画時も反映される。
    if (typeof msg.controlPanelCollapsed === 'boolean') {
      setControlsCollapsed(msg.controlPanelCollapsed);
    }

    // hierarchical (full/light) は同期描画なのでここで即座にローディングを消す。
    // physics モードは initNetwork 内 (または上の再描画パス) の
    // stabilizationIterationsDone で消す。
    if (layoutTier !== 'physics') {
      hideLoading();
    }
  }

  /**
   * physics tier (大規模グラフ) 用の共通ハンドラ登録。
   * initNetwork() (network 新規作成時) と renderGraph() (既存 network を
   * 再利用する再描画パス) の両方から呼ぶ。
   * 以前は initNetwork() 側にしか stabilizationProgress の登録が無く、
   * パネルを開いたまま2回目以降の解析で physics tier に切り替わった場合、
   * "Computing layout... NN%" の進捗表示が一切更新されず、ローディング
   * メッセージが(前回のものや"Analyzing..."のまま)固まって見えるバグがあった。
   * off() してから on() することで、同じ network インスタンスに対して
   * 複数回呼ばれても stabilizationProgress ハンドラが重複登録されない
   * (呼ぶたびに増え続けることがない)ようにする。
   */
  function bindPhysicsProgressHandlers(net) {
    document.getElementById('loading-overlay').style.display = 'flex';
    net.off('stabilizationProgress');
    net.on('stabilizationProgress', function (params) {
      document.getElementById('loading-msg').textContent =
        'Computing layout... ' + Math.round(params.iterations / params.total * 100) + '%';
    });
    net.once('stabilizationIterationsDone', function () {
      net.setOptions({ physics: { enabled: false } });
      net.fit();
      hideLoading();
    });
  }

  function initNetwork(nodeCount) {
    var tier = getLayoutTier(nodeCount);
    var opts = buildLayoutOptions(tier);

    network = new vis.Network(
      document.getElementById('network'),
      { nodes: nodes, edges: edges },
      {
        layout: opts.layout,
        nodes: {
          shape: 'dot', borderWidth: 2,
          shadow: { enabled: true, size: 4, x: 2, y: 2, color: 'rgba(0,0,0,0.08)' },
          font:   { size: 11, face: 'monospace' },
          // ノード・エッジの色/太さは nodes.update() / edges.update() で完全に手動管理しているため、
          // vis-network 標準の chosen(選択・ホバー時の自動スタイル変更。デフォルトで有効)を無効化する。
          // 有効なままだと、ノード/エッジをクリックして選択した際にネイティブの自動スタイル変更
          // (borderWidth の倍加、矢印長に比例する width の加算等)が手動スタイルと二重に競合し、
          // 選択解除後に矢印やノード枠がすごく太く表示されたまま残る不具合の原因になる。
          chosen: false
        },
        edges: {
          smooth:         { enabled: true, type: 'cubicBezier', forceDirection: 'horizontal', roundness: 0.5 },
          arrows:         { to: { scaleFactor: 0.6 } },
          color:          { color: T().edgeNormal, hover: T().edgeNormal, highlight: T().edgeNormal },
          hoverWidth:     0, selectionWidth: 0, width: 1,
          chosen:         false
        },
        interaction: {
          hover: true, tooltipDelay: 80, navigationButtons: true,
          keyboard: false, zoomView: false
        },
        physics: opts.physics,
      }
    );

    network.on('click', onNetworkClick);
    network.on('doubleClick', function (params) {
      if (params.nodes.length === 0) {
        resetAll(!!searchBox.value.trim());
      }
    });
    network.on('hoverNode', function (p) {
      if (currentNode !== null) return;
      // エッジが選択中(ネイティブのクリックによる選択)の間にノードをホバーすると、
      // このハンドラがそのエッジの色を書き換えてしまい、選択中の見た目とハイライト
      // が競合してちらついて見えていた。この状態でのノードクリックは選択解除にしか
      // ならず、ホバーしても実質意味が無いため、エッジ選択中はノードホバーの
      // ハイライトを抑制する(エッジホバー時の強調は本ハンドラの対象外なので影響しない)。
      if (network.getSelectedEdges().length > 0) return;
      edges.update(network.getConnectedEdges(p.node).map(function (id) {
        return { id: id, color: { color: T().edgeHighlighted, opacity: 1.0 }, width: 2.5 };
      }));
    });
    network.on('blurNode', function (p) {
      if (currentNode !== null) return;
      if (network.getSelectedEdges().length > 0) return;
      edges.update(network.getConnectedEdges(p.node).map(function (id) {
        return { id: id, color: { color: T().edgeNormal, opacity: 0.8 }, width: 1 };
      }));
    });

    // physics フォールバック時はスタビライズ中にローディングを表示する
    if (tier === 'physics') {
      bindPhysicsProgressHandlers(network);
    }

    network.body.container.addEventListener('wheel', function (e) {
      e.preventDefault(); e.stopPropagation();
      var scale = network.getScale();
      var pos   = network.getViewPosition();
      var speed = 120 / scale;
      if (e.ctrlKey) {
        var newScale = scale * (e.deltaY > 0 ? 0.85 : 1.15);
        // ポインター直下のワールド座標を求め、ズーム後もその点がポインター位置に
        // 留まるよう viewPosition を再計算する(中心固定ではなくポインター基準ズーム)。
        var rect    = network.body.container.getBoundingClientRect();
        var domPos  = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        var anchor  = network.DOMtoCanvas(domPos);
        var newPos  = {
          x: anchor.x - (anchor.x - pos.x) * (scale / newScale),
          y: anchor.y - (anchor.y - pos.y) * (scale / newScale)
        };
        network.moveTo({ scale: newScale, position: newPos, animation: false });
      } else if (e.shiftKey) {
        network.moveTo({ position: { x: pos.x + e.deltaY * speed / 100, y: pos.y }, animation: false });
      } else {
        network.moveTo({ position: { x: pos.x, y: pos.y + e.deltaY * speed / 100 }, animation: false });
      }
    }, { passive: false, capture: true });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ソースへジャンプ
  // ─────────────────────────────────────────────────────────────────────────

  function openNodeSource(nodeId) {
    var info = nodeInfoMap[nodeId];
    if (!info || !info.file) return;
    if (isVscode) {
      vscode.postMessage({ type: 'openFile', file: info.file, line: info.line });
    } else {
      alert('File: ' + info.file + '\nLine: ' + info.line);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ノードクリック
  // ─────────────────────────────────────────────────────────────────────────

  // 選択中ノードのハイライト塗り直し。onNetworkClick と repaintTheme(テーマのライブ
  // 切替時の再描画)で共有する。currentNode/connectedEdgesOfNode 等の状態は変更しない。
  function applySelectionHighlight(id) {
    var outgoing = new Set(network.getConnectedNodes(id, 'from')); // callees
    var incoming = new Set(network.getConnectedNodes(id, 'to'));   // callers

    // ノード自体の背景色は方向によって塗り分けたまま(選択中=青、呼び出し先=オレンジ、呼び出し元=緑)。
    nodes.update(nodes.getIds().map(function (nid) {
      if (nid === id)         return { id: nid, color: { background: '#97c2fc', border: '#5a9fd4' }, font: makeFont(T().selectedFont) };
      if (outgoing.has(nid)) return { id: nid, color: { background: '#fab1a0', border: '#e17055' }, font: makeFont(T().calleeFont) };
      if (incoming.has(nid)) return { id: nid, color: { background: '#00b894', border: '#00695c' }, font: makeFont(T().callerFont) };
      return { id: nid, color: { background: T().unrelatedBg, border: T().unrelatedBorder }, font: makeFont(T().unrelatedFont) };
    }));

    // エッジ(矢印)の色は方向による塗り分けをやめ、ホバー時と同じ単色に統一する。
    edges.update(edges.getIds().map(function (eid) {
      if (!connectedEdgesOfNode.has(eid)) return { id: eid, color: { color: T().edgeDimmed, opacity: 0.3 }, width: 1 };
      return { id: eid, color: { color: T().edgeHighlighted, opacity: 1.0 }, width: 2.5 };
    }));
  }

  function onNetworkClick(params) {
    // C5修正: macOSではCtrl+Clickがトラックパッド/OSレベルで右クリック扱いに
    // なることがあり、ctrlKeyだけに頼るとクリックできないことがある。
    // Cmd+Click(metaKey)も同じ「ソースを開く」操作として受け付ける。
    var isModifierClick = params.nodes.length > 0 && params.event && params.event.srcEvent &&
        (params.event.srcEvent.ctrlKey || params.event.srcEvent.metaKey);

    if (!params.nodes.length) {
      // 検索中はノード選択だけリセットして検索を維持する。
      // 空のとき（非検索中）は通常どおり全リセット。
      resetAll(!!searchBox.value.trim());
      return;
    }
    var id = params.nodes[0];

    if (isModifierClick) {
      // Ctrl/Cmd+Click: エディタでソースを開く。ハイライトの見た目は通常クリックと同じにする
      // (下の共通ハイライト処理に合流させる)。同じノードの再クリックでも選択解除(トグル)は
      // せず、毎回ソースを開く。
      openNodeSource(id);
    } else {
      // 同じノードを再クリック: 選択解除（検索中は検索を維持）
      if (id === currentNode) { resetAll(!!searchBox.value.trim()); return; }
    }

    currentNode          = id;
    connectedEdgesOfNode = new Set(network.getConnectedEdges(id));
    _hadSelection        = true;

    applySelectionHighlight(id);

    document.getElementById('hop-panel').style.display = 'block';
    document.querySelectorAll('.hop-btn').forEach(function (b) { b.classList.remove('active'); });

    if (document.getElementById('src-toggle').checked) showSource(id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ホップフィルタ
  // ─────────────────────────────────────────────────────────────────────────

  function getNodesWithinHops(startId, maxHops) {
    var visited  = new Set([startId]);
    var frontier = [startId];
    for (var hop = 0; hop < maxHops; hop++) {
      var next = [];
      frontier.forEach(function (id) {
        network.getConnectedNodes(id).forEach(function (nid) {
          if (!visited.has(nid)) { visited.add(nid); next.push(nid); }
        });
      });
      frontier = next;
      if (!frontier.length) break;
    }
    return visited;
  }

  function applyHopFilter(maxHops) {
    if (currentNode === null) return;

    var visible  = (maxHops === null) ? new Set(nodes.getIds()) : getNodesWithinHops(currentNode, maxHops);
    var outgoing = new Set(network.getConnectedNodes(currentNode, 'from')); // callees
    var incoming = new Set(network.getConnectedNodes(currentNode, 'to'));   // callers

    nodes.update(nodes.getIds().map(function (id) {
      var d = defaultNodeColors[id] || {};
      if (!visible.has(id))        return { id: id, color: { background: T().hopHiddenBg, border: T().hopHiddenBorder }, font: makeFont(T().hopHiddenFont) };
      if (id === currentNode)       return { id: id, color: { background: '#97c2fc', border: '#5a9fd4' }, font: makeFont(T().selectedFont) };
      if (outgoing.has(id))         return { id: id, color: { background: '#fab1a0', border: '#e17055' }, font: makeFont(T().calleeFont) };
      if (incoming.has(id))         return { id: id, color: { background: '#00b894', border: '#00695c' }, font: makeFont(T().callerFont) };
      return { id: id, color: d.color, font: makeFont(T().nodeFontDefault) };
    }));

    edges.update(edges.getIds().map(function (id) {
      var e = edges.get(id);
      if (!visible.has(e.from) || !visible.has(e.to))
        return { id: id, color: { color: T().edgeHopDimmed, opacity: 0.2 }, width: 1 };
      if (connectedEdgesOfNode.has(id)) {
        return { id: id, color: { color: T().edgeHighlighted, opacity: 1.0 }, width: 2.5 };
      }
      return { id: id, color: { color: T().edgeNormal, opacity: 0.6 }, width: 1 };
    }));

    document.querySelectorAll('.hop-btn').forEach(function (btn) {
      var _hop = maxHops === null ? 'all' : String(maxHops);
      btn.classList.toggle('active', btn.dataset.hop === _hop);
    });
  }

  document.querySelectorAll('.hop-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var v = btn.dataset.hop === 'all' ? null : parseInt(btn.dataset.hop, 10);
      applyHopFilter(v);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ソースコードパネル
  // ─────────────────────────────────────────────────────────────────────────

    // ソースパネルの内容を実際に DOM に書き込む（source が既にある場合）
  function _renderSourceContent(nodeId) {
    var info        = nodeInfoMap[nodeId] || {};
    var placeholder = document.getElementById('source-placeholder');
    var content     = document.getElementById('source-content');
    var baseName    = info.file ? info.file.replace(/\\/g, '/').split('/').pop() : '';
    document.getElementById('source-func-name').textContent = info.labelFull || info.label || nodeId;
    document.getElementById('source-file-info').textContent =
      baseName ? (baseName + ' : line ' + info.line) : '';
    if (info.source !== null && info.source !== undefined) {
      // 行番号を付与して表示（info.line = スコープ開始行）
      var startLine = info.line || 1;
      var sourceLines = info.source.split('\n');
      var maxNum = startLine + sourceLines.length - 1;
      var pad    = String(maxNum).length;
      var numbered = sourceLines.map(function (l, i) {
        return String(startLine + i).padStart(pad) + '  ' + l;
      }).join('\n');
      document.getElementById('source-code').textContent = numbered;
      placeholder.style.display = 'none';
      content.style.display     = 'flex';
    } else {
      document.getElementById('source-code').textContent = '';
      placeholder.style.display = 'flex';
      content.style.display     = 'none';
    }
  }

  function showSource(nodeId) {
    var panel = document.getElementById('source-panel');
    panel.style.display = 'flex';

    if (!nodeId) {
      document.getElementById('source-placeholder').style.display = 'flex';
      document.getElementById('source-content').style.display     = 'none';
      currentSourceNodeId = null;
      return;
    }

    currentSourceNodeId = nodeId;
    var info = nodeInfoMap[nodeId] || {};

    // キャッシュ済みなら即表示
    if (info.source !== null && info.source !== undefined) {
      _renderSourceContent(nodeId);
      return;
    }

    // VSCode WebView 環境: requestSource を送って非同期取得
    if (isVscode && info.file) {
      // 同じノードに対して既に requestSource を送信済みで応答待ちの場合は、
      // 何もせず現在の "// Loading..." 表示を維持する。
      // (修正前は pendingSourceNodeId !== nodeId が false になりこの if を素通りして
      //  下の "(Source not found)" が一瞬誤表示されていた)
      if (pendingSourceNodeId === nodeId) return;
      pendingSourceNodeId = nodeId;
      // ヘッダ表示だけ先行描画し、ソース部分は "読み込み中..." を表示
      var baseName = info.file ? info.file.replace(/\\/g, '/').split('/').pop() : '';
      document.getElementById('source-func-name').textContent = info.labelFull || info.label || nodeId;
      document.getElementById('source-file-info').textContent =
        baseName ? (baseName + ' : line ' + info.line) : '';
      document.getElementById('source-code').textContent = '// Loading...';
      document.getElementById('source-placeholder').style.display = 'none';
      document.getElementById('source-content').style.display     = 'flex';
      vscode.postMessage({
        type: 'requestSource',
        nodeId:   nodeId,
        file:     info.file,
        line:     info.line,
        scopeEnd: info.scopeEnd,
      });
      return;
    }

    // スタンドアロン HTML またはファイル情報なし
    document.getElementById('source-code').textContent = '(Source not found)';
    document.getElementById('source-placeholder').style.display = 'none';
    document.getElementById('source-content').style.display     = 'flex';
  }

  function closeSrcPanel() {
    document.getElementById('src-toggle').checked         = false;
    document.getElementById('source-panel').style.display = 'none';
    // パネルを閉じたら currentSourceNodeId をクリアし、
    // 次のクリック時に _renderSourceContent が正しく呼ばれるようにする
    currentSourceNodeId = null;
  }

  document.getElementById('src-close-btn').addEventListener('click', closeSrcPanel);
  document.getElementById('goto-btn').addEventListener('click', function () {
    if (currentSourceNodeId) openNodeSource(currentSourceNodeId);
  });
  document.getElementById('src-toggle').addEventListener('change', function () {
    if (!this.checked) {
      document.getElementById('source-panel').style.display = 'none';
    } else {
      showSource(currentNode);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 警告詳細モーダル
  // ─────────────────────────────────────────────────────────────────────────

  function openWarningModal(errors) {
    document.getElementById('warning-count').textContent = String(errors.length);
    // textContent なのでエスケープ不要 (HTML として解釈されない)
    document.getElementById('warning-modal-body').textContent = errors.join('\n');
    document.getElementById('warning-modal').style.display = 'flex';
  }
  function closeWarningModal() {
    document.getElementById('warning-modal').style.display = 'none';
  }
  document.getElementById('warning-modal-close').addEventListener('click', closeWarningModal);
  document.getElementById('warning-modal').addEventListener('click', function (e) {
    if (e.target === this) closeWarningModal(); // オーバーレイ背景クリックで閉じる
  });

  // ─────────────────────────────────────────────────────────────────────────
  // HTML / PNG エクスポート
  // ─────────────────────────────────────────────────────────────────────────

  // B1修正: export-*-btn はライブwebview版のみに存在し(webviewPanel.ts で
  // mode.kind === 'webview' の場合のみ描画)、スタンドアロンHTML書き出し版には存在しない。
  // 無条件で getElementById(...).addEventListener(...) すると、
  // スタンドアロン版では null に対して addEventListener を呼ぶことになり TypeError が発生、
  // このファイル全体を包む IIFE がそこで停止して末尾の renderGraph(INITIAL_GRAPH_DATA) に
  // 到達しなくなる(=スタンドアロンHTML書き出しが常にローディング画面のまま固まる)。
  function bindExportBtn(id, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  }

  bindExportBtn('export-html-btn', function () {
    if (isVscode) vscode.postMessage({ type: 'exportHtml' });
    else alert('This file is already a standalone HTML.');
  });

  // PNG: 横幅3000px固定・グラフ全体・背景は現在のテーマ色で塗りつぶして書き出す。
  //
  // 旧実装は「画面に実際に表示されているnetwork/canvas自体」を一時的にリサイズ→
  // キャプチャ→元に戻す、という方式だった。しかしこれには副作用があった:
  //   ・画面外に退避させている間、表示中のグラフが本当に一瞬消える(ちらつく)
  //     (退避先が画面外なだけで、表示していたcanvas自体を動かしているので当然消える)
  //   ・network.setSize()を明示的に呼ぶと、それ以降vis-network内蔵の自動リサイズ
  //     追従が効かなくなることがあり、エクスポート後にVS Codeウィンドウを最大化しても
  //     グラフのキャンバスが拡大前のサイズのまま固定されてしまう
  //   ・上記の影響で、位置の保存/復元(moveTo)のタイミング次第でグラフの表示位置が
  //     まれにズレる
  //
  // そこで、表示中のnetwork/nodes/edgesには一切触れず、同じデータの複製(独立した
  // DataSet)を使って画面外に「影武者」のvis.Networkを都度新しく作り、そこから
  // キャプチャした後は丸ごと破棄する方式に変更した。表示中のグラフは触れられて
  // すらいないので、ちらつき・自動リサイズ破損・位置ズレのいずれも起こり得ない。
  var EXPORT_PNG_WIDTH = 3000;
  var EXPORT_PADDING   = 0.03; // 余白の割合(以前はfit()任せで余白が大きすぎた)
  bindExportBtn('export-png-btn', function () {
    if (!isVscode) { alert('This export is only available from the VS Code webview.'); return; }
    if (!network || !nodes || !edges) return;

    var positions = network.getPositions();
    var nodeList  = nodes.get();
    var edgeList  = edges.get();

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodeList.forEach(function (n) {
      var p = positions[n.id]; if (!p) return;
      var r = n.size || 12;
      minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r);
      minY = Math.min(minY, p.y - r); maxY = Math.max(maxY, p.y + r);
    });
    if (!isFinite(minX)) { minX = -100; maxX = 100; minY = -100; maxY = 100; }
    var contentW = Math.max(1, maxX - minX);
    var contentH = Math.max(1, maxY - minY);
    var exportHeight = Math.min(Math.max(Math.round(EXPORT_PNG_WIDTH * (contentH / contentW)), 400), 20000);

    // 影武者用の独立したDataSet。現在の座標(positions)を fixed:{x:true,y:true} で
    // そのまま固定するので、レイアウト計算(hierarchical/physics)は一切走らず、
    // 今画面に見えている配置と完全に一致する。表示中のDataSetは共有しない
    // (spread + 上書きで新規オブジェクトを作るだけなので、表示中のグラフを書き換える心配はない)。
    var shadowNodes = new vis.DataSet(nodeList.map(function (n) {
      var p = positions[n.id] || { x: 0, y: 0 };
      return Object.assign({}, n, { x: p.x, y: p.y, fixed: { x: true, y: true } });
    }));
    var shadowEdges = new vis.DataSet(edgeList);

    var hiddenContainer = document.createElement('div');
    hiddenContainer.style.position = 'fixed';
    hiddenContainer.style.left     = '-99999px';
    hiddenContainer.style.top      = '0';
    hiddenContainer.style.width    = EXPORT_PNG_WIDTH + 'px';
    hiddenContainer.style.height   = exportHeight + 'px';
    document.body.appendChild(hiddenContainer);

    var shadowNetwork;
    function cleanup() {
      if (shadowNetwork) shadowNetwork.destroy();
      hiddenContainer.remove();
    }

    try {
      shadowNetwork = new vis.Network(
        hiddenContainer,
        { nodes: shadowNodes, edges: shadowEdges },
        { autoResize: false, physics: { enabled: false } }
      );
      shadowNetwork.moveTo({
        position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
        scale: Math.min(
          (EXPORT_PNG_WIDTH * (1 - EXPORT_PADDING * 2)) / contentW,
          (exportHeight     * (1 - EXPORT_PADDING * 2)) / contentH
        ),
        animation: false,
      });

      // moveTo()後の再描画が反映されるのを2フレーム分待ってからキャプチャする。
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          try {
            var srcCanvas = hiddenContainer.querySelector('canvas');
            var out = document.createElement('canvas');
            out.width  = srcCanvas.width;
            out.height = srcCanvas.height;
            var ctx = out.getContext('2d');
            // vis-networkのcanvas自体は背景を描画しない(透過)ため、
            // 先に現在のテーマ背景色を塗ってから重ねて不透明化する。
            ctx.fillStyle = T().bg;
            ctx.fillRect(0, 0, out.width, out.height);
            ctx.drawImage(srcCanvas, 0, 0);
            vscode.postMessage({ type: 'exportPng', dataUrl: out.toDataURL('image/png') });
          } catch (e) {
            console.error('PNG export failed:', e);
          } finally {
            cleanup();
          }
        });
      });
    } catch (e) {
      console.error('PNG export failed:', e);
      cleanup();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 引数表示トグル
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * showFullSig が false なら label（短縮名）、true なら labelFull（フルシグネチャ）を返す。
   * labelFull が未設定の場合は label にフォールバックする。
   */
  function getLabel(info) {
    if (!showFullSig) return info.label || '';
    return info.labelFull || info.label || '';
  }

  /** 全ノードのラベルを現在の showFullSig に合わせて一括更新する。 */
  function applyLabelMode() {
    if (!nodes) return;
    nodes.update(nodes.getIds().map(function (id) {
      var info = nodeInfoMap[id];
      if (!info) return { id: id };
      return { id: id, label: getLabel(info) };
    }));
  }

  document.getElementById('sig-toggle').addEventListener('change', function () {
    showFullSig = this.checked;
    applyLabelMode();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // フォントサイズ
  // ─────────────────────────────────────────────────────────────────────────

  function makeFont(color) {
    return { size: canvasFontSize, face: 'monospace', color: color };
  }

  function applyFontSize() {
    if (!nodes) return;
    nodes.update(nodes.getIds().map(function (id) {
      var n  = nodes.get(id);
      var fc = (n.font && n.font.color) ? n.font.color : T().nodeFontDefault;
      return { id: id, font: { size: canvasFontSize, face: 'monospace', color: fc } };
    }));
  }

  // applyFontSize のデバウンス版。
  // input イベントはキー押下ごとに連続発火するため、16ms のデバウンスで
  // 高頻度の全ノード再描画を抑制する。click イベントはデバウンスなしで直接呼ぶ。
  var _fontSizeTimer;
  function applyFontSizeDebounced() {
    clearTimeout(_fontSizeTimer);
    _fontSizeTimer = setTimeout(applyFontSize, 16);
  }

  document.getElementById('font-size-input').addEventListener('input', function () {
    var val = parseInt(this.value, 10);
    if (!isNaN(val) && val >= 6 && val <= 64) { canvasFontSize = val; applyFontSizeDebounced(); }
  });
  document.getElementById('font-size-reset').addEventListener('click', function () {
    canvasFontSize = DEFAULT_FONT_SIZE;
    document.getElementById('font-size-input').value = DEFAULT_FONT_SIZE;
    applyFontSize();
  });
  // ＋ / － ボタン: ネイティブスピナーを置き換える
  document.getElementById('font-size-up').addEventListener('click', function () {
    var input = document.getElementById('font-size-input');
    var cur   = parseInt(input.value, 10);
    if (isNaN(cur)) cur = DEFAULT_FONT_SIZE;
    var val   = Math.min(cur + 1, 64);
    input.value    = val;
    canvasFontSize = val;
    applyFontSize();
  });
  document.getElementById('font-size-down').addEventListener('click', function () {
    var input = document.getElementById('font-size-input');
    var cur   = parseInt(input.value, 10);
    if (isNaN(cur)) cur = DEFAULT_FONT_SIZE;
    var val   = Math.max(cur - 1, 6);
    input.value    = val;
    canvasFontSize = val;
    applyFontSize();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // コントロールパネル 折りたたみ
  // ─────────────────────────────────────────────────────────────────────────
  // コントロールパネル折りたたみ
  // collapsed 変数を module スコープに昇格し、renderGraph から初期状態を適用できるようにする。
  var _ctrlCollapsed = false;
  var _ctrlOpenWidth = '';

  function setControlsCollapsed(val) {
    var toggleBtn = document.getElementById('controls-toggle');
    var controls  = document.getElementById('controls');
    var body      = document.getElementById('controls-body');
    _ctrlCollapsed = val;
    if (_ctrlCollapsed) {
      // 閉じる直前に実幅を取得して固定（0 の場合は CSS デフォルト幅をそのまま使う）
      var w = controls.getBoundingClientRect().width;
      _ctrlOpenWidth       = w > 0 ? w + 'px' : '';
      controls.style.width = _ctrlOpenWidth;
    } else {
      // 開いたら固定幅を解除 (CSS の width: 230px に戻る)
      controls.style.width = '';
    }
    body.style.display    = _ctrlCollapsed ? 'none' : '';
    toggleBtn.textContent = _ctrlCollapsed ? '▶' : '▼';
    toggleBtn.title       = _ctrlCollapsed ? 'Expand panel' : 'Collapse panel';
  }

  (function () {
    var toggleBtn = document.getElementById('controls-toggle');
    toggleBtn.addEventListener('click', function () {
      setControlsCollapsed(!_ctrlCollapsed);
    });
  }());

  // ─────────────────────────────────────────────────────────────────────────
  // 検索
  // ─────────────────────────────────────────────────────────────────────────

  var searchBox = document.getElementById('search-box');

  // ─── 検索モードトグル（func / file、両方 ON がデフォルト） ──────────────
  var searchModeFunc = true;
  var searchModeFile = true;
  (function () {
    var btnFunc = document.getElementById('search-mode-func');
    var btnFile = document.getElementById('search-mode-file');
    function applyToggle(btn, isActive) {
      btn.classList.toggle('active', isActive);
    }
    btnFunc.addEventListener('click', function () {
      // 両方 OFF にはできない: 片方だけ ON の状態でそれを押した場合は無視
      if (searchModeFunc && !searchModeFile) return;
      searchModeFunc = !searchModeFunc;
      applyToggle(btnFunc, searchModeFunc);
      // モード変更時に検索クエリを再適用
      searchBox.dispatchEvent(new Event('input'));
    });
    btnFile.addEventListener('click', function () {
      if (searchModeFile && !searchModeFunc) return;
      searchModeFile = !searchModeFile;
      applyToggle(btnFile, searchModeFile);
      searchBox.dispatchEvent(new Event('input'));
    });
  }());

  // ─── 検索インデックス ────────────────────────────────────────────────────
  // -1 = 未フォーカス（初期値）。Enter で +1、Shift+Enter で -1 して循環する。
  var searchHitIndex = -1;
  // matchSet を外スコープで保持し、keydown ハンドラでの全スキャン再実行を廃止する。
  var matchSet = new Set();

  // 検索ヒットのハイライト塗り直し。searchBox の input ハンドラ と repaintTheme で共有する。
  // matchSet の中身(どのノードがヒットしたか)は再計算せず、色だけを塗り直す。
  function applySearchHighlight() {
    nodes.update(nodes.getIds().map(function (id) {
      if (matchSet.has(id)) {
        var d = defaultNodeColors[id] || {};
        return { id: id, color: d.color, font: makeFont(T().nodeFontDefault) };
      }
      return { id: id, color: { background: T().hopHiddenBg, border: T().hopHiddenBorder }, font: makeFont(T().searchDimFont) };
    }));
  }

  searchBox.addEventListener('input', function () {
    searchHitIndex = -1; // 入力変更時はリセット
    matchSet = new Set();
    if (!nodes) return;
    var q = this.value.trim().toLowerCase();
    if (!q) { resetAll(); return; }
    // 検索はノード選択・ホップフィルタとは独立したモードとして扱う。
    // 選択中に検索を始めると、ノード色だけが検索結果色(マッチ=元色/非マッチ=グレー)に
    // 上書きされる一方、エッジの色・太さは選択時のまま取り残され、
    // 「ノードは検索結果色なのに線だけ前の選択状態のまま」というチグハグな表示になっていた。
    // そのため、色付けの前に選択状態(ノード選択・ホップフィルタ表示)を明示的にクリアする。
    if (currentNode !== null) {
      currentNode          = null;
      connectedEdgesOfNode = new Set();
      _hadSelection         = false;
      pendingSourceNodeId  = null;
      if (network) network.unselectAll();
      document.getElementById('hop-panel').style.display = 'none';
      document.querySelectorAll('.hop-btn').forEach(function (b) { b.classList.remove('active'); });
      if (edges) {
        edges.update(edges.getIds().map(function (id) {
          return { id: id, color: { color: T().edgeNormal, opacity: 0.8 }, width: 1 };
        }));
      }
    }
    Object.keys(nodeInfoMap).forEach(function (id) {
      var info    = nodeInfoMap[id];
      var matched = false;
      // func モード: label (短縮名) と labelFull (フルシグネチャ) で検索
      if (searchModeFunc) {
        if ((info.label     || '').toLowerCase().indexOf(q) !== -1 ||
            (info.labelFull || '').toLowerCase().indexOf(q) !== -1) {
          matched = true;
        }
      }
      // file モード: ファイルのベース名で検索（OR 条件）
      if (!matched && searchModeFile) {
        var basename = (info.file || '').replace(/\\/g, '/').split('/').pop() || '';
        if (basename.toLowerCase().indexOf(q) !== -1) matched = true;
      }
      if (matched) matchSet.add(id);
    });
    applySearchHighlight();
  });

  searchBox.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && nodes) {
      var hits = Array.from(matchSet);
      if (hits.length) {
        // Enter で +1、Shift+Enter で -1 して循環（index が常に現在位置を指す）
        if (e.shiftKey) {
          searchHitIndex = (searchHitIndex - 1 + hits.length) % hits.length;
        } else {
          searchHitIndex = (searchHitIndex + 1) % hits.length;
        }
        network.focus(hits[searchHitIndex], { scale: 1.5, animation: { duration: 400 } });
      }
    }
    if (e.key === 'Escape') {
      // stopPropagation で document の keydown ハンドラへの伝播を止めて
      // resetAll の二重呼び出しを防ぐ
      e.stopPropagation();
      resetAll();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // リセット
  // ─────────────────────────────────────────────────────────────────────────

  // preserveSearch=true のとき: ノード選択状態だけリセットし、
  //   検索ボックス・matchSet・ソースパネルには手を触れない。
  //   外から値を save/restore する方式は network.unselectAll() が
  //   synchronous に内部イベントを再発火したとき途中で崩れるため、
  //   resetAll 内部で完結させることで再入性の問題を回避する。
  function resetAll(preserveSearch) {
    // ノードクリック時は接続・非接続エッジ両方のスタイルが変わるため、
    // 選択があった場合は必ず全エッジをリセットする。
    // 一度もノードを選択していない場合（Esc 連打など）はスキップして最適化する。
    //
    // _hadSelection は「自前のハイライト処理(onNetworkClickの通常クリック)を実行したか」
    // だけを表すフラグで、次の2ケースでは true にならないまま vis-network 側の
    // ネイティブな選択状態(エッジの色/ノードの枠太さ等)が変化してしまっていた:
    //   ケースA: エッジを直接クリックした場合(params.nodes.length===0 のため resetAll直行)
    //   ケースB: Ctrl/Cmd+クリックでソースへジャンプした場合(即returnのため_hadSelection未更新)
    // これらを取りこぼさないよう、_hadSelection に加えて vis-network 側に実際に
    // 選択されているものが無いかも判定に使う。
    // getSelectedNodes()/getSelectedEdges() は unselectAll() を呼んだ後は必ず空になるため、
    // 判定は unselectAll() を呼ぶ前に行うこと。
    var prevHadSelection = _hadSelection ||
      (network && (network.getSelectedNodes().length > 0 || network.getSelectedEdges().length > 0));
    currentNode          = null;
    connectedEdgesOfNode = new Set();
    _hadSelection        = false;
    // resetAll 後に同じノードを再クリックしても requestSource が再送されるよう
    // pendingSourceNodeId をクリアする
    pendingSourceNodeId  = null;
    if (!preserveSearch) {
      matchSet       = new Set();
      searchHitIndex = -1;
    } else {
      // 検索保持時もフォーカス位置はリセット（ノード選択が変わったため）
      searchHitIndex = -1;
    }
    if (network) network.unselectAll();
    if (nodes) {
      if (preserveSearch && matchSet.size > 0) {
        // 検索ハイライト色を維持したままノード選択だけ外す
        applySearchHighlight();
      } else {
        nodes.update(nodes.getIds().map(function (id) {
          var d = defaultNodeColors[id] || {};
          return { id: id, color: d.color, font: makeFont(T().nodeFontDefault) };
        }));
      }
    }
    // 前回選択がなければエッジは変更されていないのでスキップ（最適化）
    if (edges && prevHadSelection) {
      edges.update(edges.getIds().map(function (id) {
        return { id: id, color: { color: T().edgeNormal, opacity: 0.8 }, width: 1 };
      }));
    }
    document.getElementById('hop-panel').style.display = 'none';
    document.querySelectorAll('.hop-btn').forEach(function (b) { b.classList.remove('active'); });
    if (!preserveSearch) {
      document.getElementById('search-box').value = '';
      if (document.getElementById('src-toggle').checked) {
        showSource(null);
      } else {
        document.getElementById('source-panel').style.display = 'none';
      }
    }
  }

  // テーマのライブ切替(callatlas.colorTheme: auto)専用の再描画。
  // resetAll() と違い、検索・選択・Hop filterの状態は一切変更せず、
  // 「現在どの状態を表示中か」に応じて対応するハイライト処理を色だけ再実行する。
  function repaintTheme() {
    if (!nodes) return;
    if (currentNode !== null) {
      // ノード選択中(Hop filter適用有無を問わない)。
      // 検索中に既存のマッチ候補を選択した場合(matchSetは選択時にクリアされない)も、
      // UI上の実際の優先順位(選択 > 検索)に合わせて選択ハイライトを優先する。
      var activeBtn = document.querySelector('.hop-btn.active');
      if (activeBtn) {
        applyHopFilter(activeBtn.dataset.hop === 'all' ? null : parseInt(activeBtn.dataset.hop, 10));
      } else {
        applySelectionHighlight(currentNode);
      }
    } else if (matchSet.size > 0) {
      // 検索結果ハイライト中(選択なし)
      applySearchHighlight();
    } else {
      // 何も選択・検索していない通常状態
      nodes.update(nodes.getIds().map(function (id) {
        var d = defaultNodeColors[id] || {};
        return { id: id, color: d.color, font: makeFont(T().nodeFontDefault) };
      }));
      if (edges) {
        edges.update(edges.getIds().map(function (id) {
          return { id: id, color: { color: T().edgeNormal, opacity: 0.8 }, width: 1 };
        }));
      }
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var modal = document.getElementById('warning-modal');
    if (modal.style.display === 'flex') { closeWarningModal(); return; }
    resetAll();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ファイル凡例
  // ─────────────────────────────────────────────────────────────────────────

  function renderLegend(fileLegend) {
    var container = document.getElementById('legend-items');
    container.innerHTML = '';
    (fileLegend || []).forEach(function (item) {
      var name = item.file.replace(/\\/g, '/').split('/').pop();
      var row  = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:11px;cursor:default;';
      row.title = item.file; // C1修正: .title はDOMプロパティなのでHTMLエスケープ不要
      var dot  = document.createElement('span');
      // cssText への直接連結は CSS インジェクションの経路になるため個別プロパティ代入にする
      dot.style.width        = '10px';
      dot.style.height       = '10px';
      dot.style.borderRadius = '50%';
      dot.style.flexShrink   = '0';
      dot.style.background   = item.color;
      dot.style.border       = '1.5px solid ' + item.border;
      var label = document.createElement('span');
      label.style.color        = 'var(--atlas-text)';
      label.style.overflow     = 'hidden';
      label.style.textOverflow = 'ellipsis';
      label.style.whiteSpace   = 'nowrap';
      label.style.maxWidth     = '160px';
      label.textContent = name;
      row.appendChild(dot); row.appendChild(label);
      container.appendChild(row);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 起動
  // ─────────────────────────────────────────────────────────────────────────

  if (typeof INITIAL_GRAPH_DATA !== 'undefined') {
    renderGraph(INITIAL_GRAPH_DATA);
  } else {
    vscode.postMessage({ type: 'ready' });
  }

})();