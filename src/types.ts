/**
 * types.ts  ─  拡張機能全体で共有する型定義
 *
 * このファイルは他のモジュールに依存しない。
 * webviewPanel.ts が GraphData / MAX_SOURCE_LINES を
 * callGraphBuilder.ts 経由ではなく直接 import できるようにするための分離。
 */

export interface GraphNode {
  id:            string;
  label:         string;   // 表示用 (短縮名)
  labelFull:     string;   // フルシグネチャ (ソースパネル用)
  file:          string;
  line:          number;
  scopeEnd?:     number;   // 遅延読み込み用スコープ終端行 (1-indexed)
  source?:       string;   // 予約フィールド(現状どの生成経路でも設定されない)。
                            // WebViewでは requestSource でノードごとに遅延取得する。
                            // スタンドアロンHTML書き出し版はソースを埋め込まないため、
                            // 「Show source panel」は無効化して表示している。
  isCurrentFile: boolean;
}

export interface GraphEdge { from: string; to: string; }

export interface GraphData {
  nodes:       GraphNode[];
  edges:       GraphEdge[];
  fileName:    string;
  buildTimeMs: number;
  errors:      string[];
  /** どちらのバックエンドで解決されたか。callGraphBuilder.ts が resolveBackend() 後に設定する。
   *  保存ファイル名の lsp_/gtags_ プレフィックス判定に使用。 */
  backend?:    'lsp' | 'gtags';
  /** どのコマンドで作られたか。extension.ts の buildAndOutput() が設定する。
   *  保存ファイル名の末尾(省略系サフィックス)判定に使用。 */
  kind?:       'file' | 'func' | 'path' | 'workspace' | 'folder';
  /** 保存ファイル名に使う「対象名」(ワークスペース名/フォルダ名/ファイル名/関数名)。
   *  extension.ts の buildAndOutput() が設定する。 */
  subject?:    string;
}

export type Backend = 'lsp' | 'gtags' | 'auto';

export interface GtagEntry {
  name:       string;
  file:       string;   // 絶対パス
  line:       number;
  sourceLine: string;
  isFunc:     boolean;
}

export interface ScopeEntry {
  name:  string;
  start: number; // 関数開始行 (1-indexed)
  end:   number; // 関数終了行 (inclusive)
}

export interface ScopeMapEntry {
  list:   ScopeEntry[];            // 行範囲検索用
  byName: Map<string, ScopeEntry>; // 名前引き O(1) ルックアップ用
}

/**
 * gtagsEntryToNode の scopeEnd フォールバック計算と
 * webviewPanel.ts の requestSource ハンドラで共有する上限行数。
 */
export const MAX_SOURCE_LINES = 200;