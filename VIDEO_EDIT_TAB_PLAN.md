# Video Editサブタブ「簡易動画編集機能」実装計画

## Context

Video タブは Plan（バッチ動画生成）/ Asset・Project（生成済み動画の一覧）まで実装済みだが、Edit サブタブは `templates/index.html:2895` の空div `#wfm-video-subtab-edit`（「Editing tools coming soon」のプレースホルダーテキストのみ）で、JSロジックは一切無い。ユーザーからは「Adobe Premiereのような簡易動画編集機能」を追加したいという要望があり、調査の結果ComfyUI Core 0.35.0〜0.36.0（2026年9月時点の最新）で `VideoSlice`/`VideoTrim`/`VideoCrop`/`ConcatenateVideo` 等のネイティブ動画編集プリミティブが追加されたばかりであることが判明した。これらを活用しつつ、wf-manager独自のタイムラインUIを被せることで、フルスクラッチでの動画処理実装を避けつつ「複数クリップの配置・トリム・結合」という編集の核となる機能を提供する。

**方針確認済み（ユーザー承認）:**
- MVPスコープは最小限（タイムライン配置・トリム・結合書き出しのみ）とし、クロップ・テキストオーバーレイ・BGM合成は明確にPhase 2以降の拡張として切り離す。
- グラフ組立（トリム/クロップ/結合）はComfyUIワークフローに丸投げする方式（Plan tabの`video-workflow.js`と同じ`/prompt`実行基盤を再利用）で進める。`VideoTrim`/`VideoCrop`がexperimental扱いであることのAPI変更リスクは、Phase 0での`/object_info`検証とクラス名参照で軽減する。

実装は下記のPlanエージェント設計をベースに、MVPスコープをPhase 1（タイムライン+トリム+結合）のみに絞り込んで進める。

---

## 1. スコープ定義

### 設計原則（切り分けの判断基準）

| 種別 | 判断基準 | 実装場所 |
|---|---|---|
| **プレビュー/操作UI**（scrub再生、タイムライン上でのドラッグ、トリムハンドル、テキスト位置決めなど、ユーザーが「見ながら触る」もの） | ブラウザの`<video>`/`<canvas>`だけで完結し、即座にフィードバックが必要 | wf-manager独自JS（video-edit-tab.js） |
| **実際の書き出し処理**（トリム確定、複数クリップ結合、クロップ確定、テキスト焼き込み） | 重い処理・GPU不要・単純なメディア操作で、ComfyUI Coreの新ノード(VideoSlice/VideoTrim/VideoCrop/ConcatenateVideo)がほぼそのままカバーする | ComfyUIワークフローを動的組立して`/prompt`に投げる（Plan tabのvideo-workflow.jsパターンを踏襲） |
| **既存方針(PyAV+Pillowのみ、ffmpeg非依存)で完結できないもの**（テキスト/字幕の焼き込み、BGM音量ミックス、簡単なフェード） | ComfyUI Coreノードにも無く、かつ静止画向けtext-overlay系カスタムノードのロジックを流用できる規模 | wf-manager独自Python（video_service.py拡張、PyAV decode + Pillow ImageDraw合成 + PyAV encode） |
| **サムネイル/ファイル一覧/タグ管理** | 既存Galleryインフラで完結 | 既存流用（新規実装なし） |

### MVP（初回リリース、承認済み: 最小限スコープ）

以下の1〜4のみを初回リリース対象とする。クロップ／テキストオーバーレイ／BGM合成／プレビュー高度化は明確にPhase 2以降へ切り出す。

1. **タイムラインへのクリップ配置・並べ替え**
   - Asset タブ / Gallery からドラッグ or 「Editへ送る」ボタンで動画をタイムラインに追加。
   - 水平方向に複数クリップを並べたシンプルな1トラック構成（Adobe Premiereの「V1」トラック1本のみ、複数トラック無し）。
   - ドラッグで順序入れ替え、削除、複製。
2. **クリップ単位のトリム（開始/終了）**
   - 各クリップサムネイル上でハンドルをドラッグしてin/outを指定 → プレビューは`<video>`要素のcurrentTimeシークのみ（デコード不要、軽量）。
   - 書き出し時にComfy Core `VideoSlice`（"Trim Video"）ノードで実処理。
3. **複数クリップの結合書き出し**
   - タイムライン順に`ConcatenateVideo`ノードをAutogrowで連結し1本のVIDEO出力に。
4. **プレビューと書き出し**
   - プレビューはMVPでは「各クリップを順番に`<video>`要素で連続再生する疑似プレビュー」（トリム区間のみ再生してクリップ切り替え）に留める。真の合成プレビューは行わない。
   - 「書き出し」ボタン押下でComfyUIワークフロー（`VideoSlice`×N → `ConcatenateVideo`(Autogrow) → `SaveVideo`）を動的組立し`/prompt`に投げ、進捗はWebSocketで表示、完了後Galleryの`VIDEO_GROUP`に自動登録。

### Phase 2以降（MVP対象外、将来拡張として明記）

- **クリップ単位の空間クロップ**: 矩形選択UI（Image Edit Tabのキャンバス選択パターンを流用）→ 書き出し時に`VideoCrop`ノードへ座標を渡す。
- **簡易テキストオーバーレイ（クリップ単位、固定位置・フェード無し）**: テキスト内容・フォントサイズ・色・位置（9グリッドアンカー）・表示区間(開始秒-終了秒)を指定。書き出しはPyAVでフレームデコード→対象区間のフレームだけPillow ImageDraw.textで焼き込み→再エンコード（wf-manager独自Python実装。ComfyUI Coreに動画テキストオーバーレイノードは無いため）。
- **BGM/音声トラック1本の合成**: 元動画の音声をmute/keep選択 + 1本のBGM音声ファイルを全体に重ねる（音量スライダーのみ、ミキシングはPyAVのAudioResampler+単純加算 or `CreateVideo`のcomplete_audio差し替え機能で代替）。複雑なマルチトラックオーディオミキシングは対象外。
- 複数トラック（V1/V2でのピクチャーインピクチャー、オーバーレイ合成）
- クリップ間トランジション（クロスフェード等） — フレーム単位のアルファブレンドはPyAVで可能だが計算コストが高く、CPUのみだと低速。GPU処理が要るなら別途ComfyUIノード化を検討。
- 波形表示付きオーディオトラック編集
- キーフレームアニメーション（テキストの移動/フェードイン等）
- Undo/Redo履歴、複数プロジェクトの保存/読込（Video Planの`video_plan_service.py`と同様の永続化）
- リアルタイム合成プレビュー（WebCodecs APIによるブラウザ内デコード合成、または低解像度プロキシファイルを都度サーバー生成してプレビュー用に配信）

---

## 2. アーキテクチャ

> **補足（実際のサブタブ構造）**: Videoタブは単純な「Plan/Asset/Edit」3分割ではなく、中央ペインが Plan/Edit の2-way切替（`_initCenterSubtabToggle()`, `static/js/video-tab.js:37`）、サイドバーが Asset/Project の独立ペア（`_initSidebarSubtabToggle()`, 同ファイル55行目）という構成。エントリポイントは `static/js/video-tab.js:317` の `export function initVideoTab()` で、ここに `initVideoEditTab()` の呼び出しを追加する。

### フロントエンド（JS）

新規ファイル: `static/js/video-edit-tab.js`

- `class VideoEditTab`（Image Edit Tabの`class ImageEditTab`パターンを踏襲。単一グローバルインスタンスをexportする形も選択可）
  - `constructor()`: タイムライン状態(`this.clips = []`、各要素は`{ sourceRef, inPoint, outPoint, cropRect, textOverlay, id }`)、選択中クリップID、DOM参照を初期化。
  - `init()`: DOM生成・イベント配線のエントリポイント。`video-tab.js`の`initVideoTab()`から`initVideoEditTab()`として呼ばれる形にする。
  - `_setupActionBar()`: Image Edit Tab 1385行目のアクションバー実装を参考に「クリップ追加」「書き出し」「プレビュー再生/停止」ボタン群を構築。
  - `_setupTimelinePanel()`: レイヤーパネル(`_setupLayerPanel()` 2194行目)のリスト+サムネ+ドラッグ並べ替えパターンを、縦のレイヤーリストではなく横のタイムラインクリップ列に転用。
  - `_setupTrimHandles()`: pointerdown/move/upベースのドラッグ操作(1130-1249行目のポインタイベント処理パターン)をトリムハンドルのドラッグに転用。
  - `_setupCropOverlay()`: 同じくpointerイベントパターンをクロップ矩形選択に転用（レイヤーごとに独立canvasを持つ構造は流用しないが、矩形描画のオーバーレイcanvas1枚で足りる）。
  - `_setupTextOverlayPanel()`: テキスト内容/フォント/色/アンカー/表示区間の入力フォーム。プレビューは選択中クリップの`<video>`上にCSS絶対配置したdiv要素でオーバーレイ表示（実際の焼き込みはサーバー側、プレビューは近似でよい）。
  - `_buildExportWorkflow()`: タイムライン状態からComfyUIワークフローJSON（内部APIフォーマット）を動的組立。`video-workflow.js`の`injectFrameNode()`のノード注入パターン（last_node_id/last_link_id採番、links[]整合性維持）を流用し、`LoadVideo → VideoSlice → (VideoCrop) → ConcatenateVideo(Autogrow) → SaveVideo`のグラフを構築。
  - `_exportTimeline()`: `comfyUI.queuePrompt()`/`comfyUI.trackProgress()`（comfyui-client.js既存メソッド、Plan tabと同じ呼び出し方）でグラフを実行し、進捗表示・完了後にGallery登録。
  - `_applyTextOverlayJob()`: テキストオーバーレイがある場合のみ、結合済み動画に対して追加で`/api/wfm/video/edit/overlay-text`（新設）を呼ぶ後処理ステップ（ComfyUIグラフでは焼き込めないため、書き出しフローの最終段に独立したPython後処理を挟む二段構成）。

- 既存ファイルへの変更:
  - `static/js/video-tab.js`: `initVideoEditTab()`のimportと`initVideoTab()`内呼び出しを追加。`_applyVideoI18n()`にEdit用キーを追加。
  - `templates/index.html`: `#wfm-video-subtab-edit`内にタイムライン/アクションバー/クロップオーバーレイ/テキストパネル用のDOM骨格を追加（Plan/Assetサブタブの既存マークアップ構造に合わせる）。
  - `static/js/i18n.js`: `videoEditPlaceholder`を削除し、新規i18nキー群（`videoEditTimeline`, `videoEditTrim`, `videoEditCrop`, `videoEditTextOverlay`, `videoEditBgm`, `videoEditExport`等、英/日/中3言語）を追加。
  - `static/css/video-tab.css`（存在すれば。無ければ新規`video-edit-tab.css`）: タイムラインのクリップブロック、トリムハンドル、クロップオーバーレイのスタイル。

- Asset→Edit連携用の変更:
  - `static/js/video-asset-tab.js`: 詳細パネル(`_renderDetail()`)に「Editへ送る」ボタンを追加。クリック時、選択中動画の`{filename, subfolder, type}`または`{kind:"local", file}`参照を`video-edit-tab.js`のエクスポート関数（例: `addClipFromAsset(ref)`）に渡し、Editサブタブに切り替えてタイムライン末尾に追加。

### バックエンド（Python）

判断基準: **ComfyUIワークフローに丸投げできる処理（VIDEO型を保つ、GPU不要でもCPUノードとしてグラフ内で完結できる処理）は`/prompt`実行に任せ、グラフ側に存在しない処理（テキスト焼き込み、音声ミックス、詳細メタ取得）だけを独自Pythonで実装する。** 理由: ワークフロー実行に丸投げすることで実行キュー管理・WebSocket進捗通知・キャンセル(`interrupt`)・履歴(`/history`)を無料で使い回せる一方、独自Python実装は同期/非同期の進捗通知を自前で作る必要があるため、既存インフラで代替できるものは極力グラフに寄せる。

- `py/routes/video_routes.py` 追加エンドポイント:
  - `POST /api/wfm/video/edit/probe`: アップロード済み/output上の動画の基本メタ（duration, fps, width, height, has_audio）をPyAVで取得。タイムラインUIがクリップ追加時に必要な長さ・解像度をComfyUIの`/prompt`実行なしで即座に得るため（`GetVideoComponents`ノードを都度実行するのは重く実行キューも消費するため避ける）。
  - `POST /api/wfm/video/edit/overlay-text`: 結合済み動画1本 + テキストオーバーレイ指定リスト（区間・アンカー・文字列・色・フォントサイズ）を受け取り、PyAVでデコード→対象区間のみPillow ImageDraw合成→PyAV(av.open(mode="w"))で再エンコードしoutputへ保存。`video_service.convert_to_gif()`のデコード/エンコードパターンを流用。
  - `POST /api/wfm/video/edit/mix-audio`（BGM合成が`CreateVideo`ノードのcomplete_audio差し替えだけでは足りない場合の予備、例えば音量調整付き重ね合わせが必要な時）: PyAVのAudioResamplerで元音声とBGMをリサンプル→単純加算ミックス→動画に再アタッチ。
  - Phase 1では上記のうち`probe`のみ必須、`overlay-text`はテキストオーバーレイ機能実装時に追加、`mix-audio`は`CreateVideo`の`complete_audio`で足りるなら不要（後述リスク参照）。

- `py/services/video_service.py` 追加メソッド:
  - `probe_video(path) -> dict`: `av.open()`でstreams[0]の`duration`, `average_rate`, `width`, `height`、`streams.audio`の有無を返す。
  - `overlay_text_on_video(src_path, overlays, fps=None) -> dict`: 既存`convert_to_gif`と同じ`_resolve_media_path`を使った安全なパス解決 → フレームループでtがoverlayの区間に該当する時だけPillowで文字を描画 → `av.open(dst, mode="w")`で同じcodec/fpsで書き出し。既存クラスの`_resolve_media_path()`を再利用。
  - `mix_audio(...)`: 必要になった場合のみ追加。

- ワークフロー動的組立は**フロントエンドJS側**(`_buildExportWorkflow()`)で行い、バックエンドは実行そのものに関与しない（Plan tabと同じ役割分担: `video-workflow.js`はJSでグラフJSONを操作し、`comfyUI.queuePrompt()`で`/prompt`に投げるのみ）。バックエンドに「ワークフロー組立API」を新設する必要は無い。

### 判断基準まとめ（再掲）
- VIDEO型のまま完結する操作（トリム/クロップ/結合/保存） → ComfyUIグラフ（フロントJSで組立、`/prompt`実行）
- VIDEO型を抜けてピクセル単位の追加合成が要る操作（文字焼き込み、音声ミックス） → wf-manager独自Python（PyAV+Pillow）
- 操作中のインタラクティブ操作（scrub、トリムハンドルのドラッグ、矩形選択） → ブラウザJSのみ、サーバー往復なし

---

## 3. 既存資産の再利用ポイント（具体的な参照箇所）

| 転用元 | 参照箇所 | 転用先 |
|---|---|---|
| Image Edit Tab アクションバー | `static/js/image-edit-tab.js:1385` `_setupActionBar()` | video-edit-tab.jsのツールバー（クリップ追加/書き出し/再生ボタン） |
| Image Edit Tab レイヤーパネル | `static/js/image-edit-tab.js:2194` `_setupLayerPanel()`（リスト/サムネ/透明度スライダー） | タイムラインのクリップリストUI（サムネ表示・並べ替え・削除） |
| Image Edit Tab pointerイベント | `static/js/image-edit-tab.js:1130-1249` | トリムハンドルドラッグ、クロップ矩形選択のドラッグ操作 |
| Image Edit Tab レイヤー合成構造 | `static/js/image-edit-tab.js:2035,2067,2081` | （参考程度）テキストオーバーレイのプレビュー用オーバーレイdiv重畳の考え方 |
| Gallery mp4サムネ/プレビュー | `static/js/gallery-tab.js:63` `isVideoFile()`、`972-985,1750-1766` `<video controls>` | クリップサムネイル生成、プレビューエリアの`<video>`要素の扱い |
| Gallery mp4サーバー側サムネ | `py/services/gallery_metadata.py:1349-1364` `serve_thumbnail`（PyAVで先頭フレームJPEG化） | クリップ追加時のサムネイル取得APIとして直接再利用可能（新規実装不要、`/wfm/gallery/image/thumb`をそのまま叩く） |
| Gallery mp4メタ | `py/services/gallery_metadata.py:766` `_read_mp4_metadata()` | `probe_video()`実装の参考（既存関数を直接呼ぶかロジック共有できないか要確認） |
| video-workflow.js ノード検出/注入パターン | `static/js/video-workflow.js` `locateVideoModelNodes()`, `injectFrameNode()`（last_node_id/last_link_id採番、links[]整合性） | `_buildExportWorkflow()`でVideoSlice/VideoCrop/ConcatenateVideoノードを動的追加する際のID採番・リンク整合性ロジックをそのまま流用 |
| comfyui-client.js 実行基盤 | `static/js/comfyui-client.js:196` `queuePrompt()`, `217` `trackProgress()`, `312` `generate()` | 書き出し実行・進捗表示（新規実装不要） |
| Video Asset Galleryグループ | `static/js/video-asset-tab.js` の`VIDEO_GROUP`/`VTEMP_GROUP`活用パターン | 書き出し完了後の動画を`VIDEO_GROUP`へ自動登録する処理の参考 |
| video_service.py デコード/エンコードパターン | `py/services/video_service.py:60` `convert_to_gif()`（PyAV decode→Pillow処理→再エンコード、`_resolve_media_path`によるパストラバーサル対策） | `overlay_text_on_video()`実装のテンプレートとしてほぼそのまま流用 |

---

## 3.5. 外部カスタムノードの参考実装（追加調査、ユーザー指定4件）

Video Edit実装の設計判断を補強するため、既に「フルスクリーンタイムラインエディタ」を実装している既存カスタムノードを調査した。**これらをそのまま依存として組み込むのではなく、UI/UX設計とノード分割方針の参考にする**（wf-managerはComfyUI Coreの`VideoSlice`/`ConcatenateVideo`丸投げ方針を維持するため、方式は異なる）。

| リポジトリ | 関連度 | 参考にすべき点 |
|---|---|---|
| [SonderSaid/ComfyUI-Sonder-Editor](https://github.com/SonderSaid/ComfyUI-Sonder-Editor) | **高** | マルチレーン（Video/Audio/Prompt/Guide/Driverレーン）タイムラインUI、クリップのドラッグ/トリム/分割/ミュート、レーンのロック/非表示など、Premiereライクな編集UIの完成度が高い実装例。ただし**FFmpeg 7.0以上を必須依存**としており、wf-managerの「ffmpeg非依存(PyAV+Pillowのみ)」方針とは真逆。UIレイアウト（左サイドバー=ギャラリー、中央=ビューポート+トランスポート、下部=マルチレーンタイムライン）は`video-edit-tab.js`のDOM構成の参考にする価値が高いが、実装（FFmpeg CLI呼び出し）はそのまま流用しない。 |
| [shootthesound/ComfyUI-H3Studio](https://github.com/shootthesound/ComfyUI-H3Studio) | **高** | MiniMax H3特化の統合編集ツール。単一ノードから「⤢ open timeline editor」ボタンでフルスクリーンタイムラインを起動する導線、クリップのトリム/クロスフェード/音声ミックスをまとめた「リール」書き出し機能、フィルムストリップ表示・波形表示が参考になる。**「追加のPythonライブラリ不要」と明記**されており、wf-managerの依存最小化方針と親和性が高い（実装詳細は非公開のため、"ノードのカスタムウィジェットからフルスクリーンモーダルを開く"というUIパターンのみ参考にする）。 |
| [domg73/ComfyUI-LoadVideoCrop](https://github.com/domg73/ComfyUI-LoadVideoCrop) | **中（Phase 2クロップ機能に直結）** | 公式`LoadVideo`を拡張し、動画プレビュー上でWYSIWYGにクロップ矩形を描画できる`Load Video Crop`ノード。アスペクト比ロック（1:1/2:3/3:2/3:4/4:3/9:16/16:9/21:9/Free）、`start_time`/`duration`/`strict_duration`によるロード時トリムも兼備。**「追加依存ライブラリ不要」**と明記。Phase 2の`_setupCropOverlay()`実装時、このノードの隠し入力設計（`crop_x/crop_y/crop_w/crop_h`を0..1正規化値で渡す）をComfyUI Core `VideoCrop`ノードとのパラメータ形式比較の参考にする。ノード自体を依存に追加するかはPhase 0で`VideoCrop`（Core）とどちらが安定・高機能か比較検討する。 |
| [astropuzzo/ComfyUI-MiniMax-H3-Image-Studio](https://github.com/astropuzzo/ComfyUI-MiniMax-H3-Image-Studio) | **低** | MiniMax H3モデルを使った**静止画**のT2I/I2I/参照編集ツールで、動画のタイムライン編集や結合とは無関係（対象読者はH3の画像生成ワークフロー利用者）。Video Edit実装への直接的な参考価値は無いため、調査対象から除外し将来のGenerateUI/画像生成系機能検討時の参考候補としてのみ記録する。 |

**設計への反映:**
- `_setupTimelinePanel()`（video-edit-tab.js）のDOM構成は、Sonder Editor/H3Studioのレイアウト（サイドバー=クリップ一覧、中央=プレビュー+トランスポート、下部=タイムライン）を踏襲する。ただし将来のマルチレーン拡張（Phase 2以降のBGMトラック等）を見越し、MVPの単一トラックでも「レーン」という概念でデータ構造を設計しておく（`this.clips`を`this.lanes = [{type:"video", clips:[...]}]`のような形にしておくと将来拡張が容易）。
- Phase 2のクロップUIは、LoadVideoCropの「正規化座標(0..1)でのクロップ矩形」という設計をそのまま踏襲し、ComfyUI Core `VideoCrop`ノードの実際のINPUT_TYPES（Phase 0で`/object_info`確認）と突き合わせて座標系を合わせる。
- H3Studioの「ノードのカスタムウィジェットからフルスクリーンモーダルを開く」という導線は、wf-managerでは既にVideo Editが独立サブタブとして存在するため直接は不要だが、将来「ワークフローグラフ上のノードからEditタブへジャンプする」ショートカットを追加する際の参考にする。

---

## 4. 段階的な実装ステップ（Phase分け）

### Phase 0: 下調査・技術検証（実装前必須）— **完了（2026-09-16、ComfyUI_5実機・ポート8189で検証済み）**

**確定事項（`_buildExportWorkflow()`実装時はこの仕様に厳密に従うこと）:**

1. **【2026-09-16 訂正】`VideoSlice`は「クラス名にスペースが入る」ため`/object_info/VideoSlice`が空に見えていただけで、実際には`"Video Slice"`（スペース込み）という正式なclass_typeで存在する。** ソース(`comfy_extras/nodes_video.py:448`)の`node_id="Video Slice"`を確認して判明。**トリムはこちらを使う** — `video`/`start_time`(FLOAT)/`duration`(FLOAT, 0で無制限)/`strict_duration`(BOOLEAN)というフラットな入力のみで、`VIDEO_EDIT`型のネスト構造が一切無く、`experimental`でもない。実機で`start_time=2.0, duration=3.0`を指定し、出力が実際に3.0秒になることをPyAV probeで確認済み（**当初の`VideoTrim`検証は`execution_success`だけを見て「動いた」と誤判定していた——後述の訂正参照**）。
2. **【訂正の経緯・重要な教訓】`VideoTrim`の`trim`入力（`VIDEO_EDIT`型）に一見素直なフラット値`{"start_time":.., "duration":..}`を渡すと、`node_errors`無しで`execution_success`するが、実際には一切トリムされず元動画がそのまま出力される（サイレント無視）。** 原因はソース(`comfy_extras/nodes_video.py:524`)の`execute()`が`(trim or {}).get("trim")`と一段余計にネストを剥がしてから`apply_video_trim()`に渡す実装になっており、`apply_video_trim()`は`trim=None`のとき`start_time=0.0, duration=0.0`とみなして**無条件に元動画をそのまま返す**（`comfy_extras/nodes_video.py:417-424`）ため。正しく`VideoTrim`を使うならフラットではなく**二重に入れ子**にした`{"trim": {"start_time": 0.0, "duration": 1.5}}`が必要。ただし本実装ではより単純な`Video Slice`を採用したため、`VideoTrim`は不使用。**教訓: `execution_success`は「グラフの型検証を通った」ことしか意味せず、パラメータが実際に意図通り効いたかは出力を実際にprobeして確認しない限り分からない。** 以後の実機検証では必ず出力の実測値まで確認すること。
3. **`VideoCrop`の`crop`入力も`VideoTrim`と同じ二重ネスト`.get("crop")`パターン（`comfy_extras/nodes_video.py:555`）。** Phase 2で採用する場合は`{"crop": {"x":0,"y":0,"width":W,"height":H}}`のように二重に入れ子にする必要がある（`VideoCrop`はスペース無しの`"VideoCrop"`のままで、`Video Slice`のような別名は無い）。Phase 2着手時に必ず出力を実測して再確認する。
4. **`ConcatenateVideo`の`videos`（`COMFY_AUTOGROW_V3`）は、ネストしたJSONオブジェクトではなく、ドット区切りの単一文字列キーをinputsのトップレベルに並べる。** これが最大のハマりどころで、`{"videos": {"video0": [...]}}` 等の直感的なネスト表現は**すべて`required_input_missing`で弾かれる**。正しい形式:
   ```json
   "inputs": {
     "videos.video0": ["<node_id>", 0],
     "videos.video1": ["<node_id>", 0],
     "codec": "auto"
   }
   ```
   （0始まり、`prefix + index`を単純結合した文字列がそのままキー名。ComfyUI Core `comfy_api/latest/_io.py`の`Autogrow.TemplatePrefix`/`finalize_prefix()`のドット結合ロジックに由来）。実機で2クリップ結合の`execution_success`を確認済み。
5. **`ConcatenateVideo`は解像度不一致で実行時ハードエラーになる。** 実機で960x540と1024x576の2クリップを結合させたところ`ValueError: Accumulated videos have incompatible frame dimensions`で失敗（`comfy_extras/nodes_video.py:178`）。事前チェック無しでの結合は失敗するため、**Phase 1のタイムラインUI側で解像度不一致クリップの警告表示・結合前チェックを必須実装**とする（リスク節で「推奨」としていたものを「必須」に格上げ）。
6. 動画アップロードは標準の`/upload/image`エンドポイント（`OPTIONS`で200確認済み）をそのまま使う想定（`LoadVideo`の`file`ウィジェットが`video_upload: true`を持ち、Core LoadVideo/VHS双方がこのエンドポイントを動画にも流用する既知の挙動）。Phase 1実装時に実際のアップロード→`LoadVideo`参照までを通しで確認する。
7. `LoadVideo`の`file`はCOMBO（inputフォルダ内動画ファイル名の列挙）。Asset/GalleryからEditタブへ渡す動画がComfyUI input配下に無い場合（Gallery出力やVTEMP_GROUP由来）は、書き出し前に`/upload/image`でinputへコピーしてからファイル名を`LoadVideo.file`に渡す必要がある。

### Phase 1: MVP基盤（タイムライン表示・単純トリム結合書き出しのみ）
- 新規: `static/js/video-edit-tab.js`（クラス骨格、タイムラインリスト、クリップ追加/削除/並べ替え）
- 変更: `templates/index.html`（Edit subtab DOM骨格）
- 変更: `static/js/video-tab.js`（init呼び出し追加）
- 変更: `static/js/i18n.js`（新規キー）
- 新規API: `py/routes/video_routes.py`に`/api/wfm/video/edit/probe`追加
- 変更: `py/services/video_service.py`に`probe_video()`追加
- 変更: `static/js/video-asset-tab.js`（「Editへ送る」ボタン）
- 実装内容: クリップ追加→トリムハンドルUI→書き出し(VideoSlice+ConcatenateVideo+SaveVideoのグラフ組立て`/prompt`実行)まで通す。

### Phase 2: クロップ機能
- video-edit-tab.jsに`_setupCropOverlay()`追加
- `_buildExportWorkflow()`を拡張し`VideoCrop`ノードを挿入

### Phase 3: テキストオーバーレイ
- video-edit-tab.jsに`_setupTextOverlayPanel()`追加
- 新規API: `/api/wfm/video/edit/overlay-text`
- `video_service.py`に`overlay_text_on_video()`追加
- 書き出しフローを「グラフ実行→結合済みファイル取得→overlay-text後処理呼び出し」の2段構成に変更

### Phase 4: BGM/音声合成
- `CreateVideo`ノードのcomplete_audio機能で足りるか検証した上で、足りなければ`mix-audio` API追加
- video-edit-tab.jsにBGMアップロード/音量UI追加

### Phase 5: 仕上げ・永続化（任意）
- タイムライン状態の保存/読込（`video_plan_service.py`と同様のJSON永続化を検討、`VideoEditProjectService`として新設するか判断）
- Undo/Redo（将来拡張スコープだが、Phase 5で簡易版のみ着手する場合はここ）

---

## 5. リスク・技術的懸念点

1. **VideoTrim/VideoCropのexperimental扱いリスク**
   - ComfyUI Core側で今後のマイナーバージョンでノード名・入出力仕様が変更される可能性がある。`io.VideoEdit`ウィジェット型はフロントエンドのインタラクティブUI前提の設計であり、wf-managerは独自UIから直接パラメータをJSON投入する形になるため、公式フロントエンドUIの挙動と乖離があっても気づきにくい。
   - 対策: 表示名ではなくノードのクラス名で参照する。最終的にトリムは`experimental`でも`VIDEO_EDIT`ネストでもない`"Video Slice"`（スペース込みのclass_type、`node_id="Video Slice"`）を採用したため、この項目のリスクは実質解消した。Phase 2で`VideoCrop`（こちらは`experimental`かつ`VIDEO_EDIT`の二重ネスト、代替ノード無し）を使う際は本リスクが残るため、必ず出力を実測確認する。
   - CLAUDE.mdの「ワークフローJSON整合性ルール」（last_node_id/last_link_id、links[]の3箇所整合）を`_buildExportWorkflow()`実装時に厳守する。

2. **ffmpeg非依存方針の機能的限界**
   - トランジション（クロスフェード等）やアルファブレンド合成はComfyUI Coreノードに無く、PyAVで自前実装するとフレーム単位のデコード→NumPy/Pillow合成→再エンコードとなり、CPU処理でかなり低速になる（特に長尺・高解像度動画）。MVPではトランジション無しとし、将来拡張でも「対応するなら低解像度プレビュー限定」等のスコープ限定を検討すべき。
   - コーデック非互換なクリップ同士の結合は`ConcatenateVideo`が自動的に一度デコードしてから再結合するため、異なる解像度/フレームレートのクリップを混在させると処理コストが跳ね上がる可能性がある。タイムラインUI側で「解像度/fps不一致クリップ」を警告表示する簡易チェックをPhase 1に含めることを推奨。
   - テキストオーバーレイの再エンコード（Phase 3）は全フレームを一度デコード・Pillow処理・再エンコードするため、長尺動画では書き出しに時間がかかる。プログレス表示（Frame N/Total等）をAPIレスポンスではなくポーリング or 簡易WebSocket通知で出す設計を検討（現状の`convert_to_gif`は同期一括処理でプログレス無し、これをそのまま踏襲すると長尺でUIが固まって見える点に注意）。

3. **既存Video Plan/Assetタブとのデータ連携**
   - AssetタブからEditタブへの動画受け渡しは、Asset側が持つ参照形式（Galleryの絶対パス`img.path`）とEdit側のタイムラインが必要とする形式（ComfyUIの`{filename, subfolder, type}`、またはローカルFileオブジェクト）の変換が必要。`video-asset-tab.js`の`_loadIntoSourcePreview()`が既にこの変換（Blob取得→File化→`kind:"local"`）を行っているので、同じパターンをEditタブのクリップ追加処理でも使う。ただし書き出しグラフの`LoadVideo`ノードはComfyUI input/output/temp配下のファイルを期待するため、ローカルFileの場合は動画アップロードAPIを経由してから`LoadVideo`に渡す必要がある（Phase 0の技術検証項目）。
   - Video Planタブが生成した動画は`VTEMP_GROUP`に入るため、Editタブの「クリップ追加」ソースとして「Video Plan実行結果」も選択できるようにする導線（Assetタブ経由で十分か、Editタブ内に直接「最近の生成結果」ショートカットを設けるか）はUX判断が必要。
   - タイムライン編集結果を保存/読込する永続化機能（Phase 5想定）を作る場合、`video_plan_service.py`のディレクトリ構成・ファイル命名規則を踏襲し、別サービスクラス（`VideoEditProjectService`）として分離するか、既存`VideoPlanService`を拡張するかの設計判断が必要（データモデルが「バッチ生成の入力」と「編集後のタイムライン状態」で意味的に異なるため、別クラス推奨）。

4. **並行実行時のリソース競合**
   - Edit書き出しはPlan tabのバッチ生成と同じ`/prompt`キューを使うため、Plan実行中にEdit書き出しを投げると同じキューに並ぶ。ユーザーへの「実行中」表示や二重実行防止のUI制御をPlan tab側の既存パターン（生成中はボタンdisable等）に倣って実装する。

5. **開発・デプロイ運用（CLAUDE.md既存ルール）**
   - 開発元リポジトリ(`c:\Users\statsu-11\Desktop\now_work\comfyUI-wf-maneger\ComfyUI-Workflow-Studio`)と実行時`custom_nodes`（`...\ComfyUI_5\custom_nodes\comfyui-workflow-studio`）は別実体。実機確認のたびに同期スクリプトでの全体反映が必要（部分同期は原因不明のエラーの元）。
   - `_buildExportWorkflow()`実装時はワークフローJSON整合性ルール（`last_node_id`/`last_link_id`が最大値以上、`links[]`とノード両端の`links`/`link`の3箇所整合）を厳守する。
   - Python側変更（`video_service.py`, `video_routes.py`）反映にはComfyUI完全再起動が必須（`py_compile`キャッシュではなくインポート自体が起動時一度きりのため）。

---

## 6. UI再設計（2026-09-16、ユーザー指示によりPlanタブ寄りに変更）

初回MVP実装（縦リスト+各行ボタン方式）を、以下のとおりPlan subtabのUIパターンに揃える形で再設計・実機確認済み。

- **タイムライン**: 縦リスト(`wfm-video-edit-clip-list`)から、Planタブと同じ横トラック構造(`wfm-video-edit-timeline-track`)へ変更。ただしPlanのブロックは`flex-grow`でトラック幅いっぱいに引き伸ばされるのに対し、Editのブロックは実秒数×固定px/秒(20px/秒、最小56px)の幅を持ち**左詰め**で並ぶ（空きトラックはそのまま空く）。
- **並べ替えの共有化**: 各クリップ行が持っていた▲▼⧉✕ボタンを廃止し、タイムライン直下の共有ツールバー（◀ 左へ移動 / ▶ 右へ移動 / 複製 / 削除 / クリア）に統合。Planタブの「+ Split / + Block / Delete」ツールバーと同じ「選択中の対象に対して働く共通ボタン」方式。
- **ドラッグ並べ替え**: ネイティブHTML5 D&Dでブロック同士のドラッグ&ドロップによる並べ替えにも対応（ボタンと併用可）。`_reorderByDrop()`は「削除→対象の新インデックスを探索→挿入」の順で行い、素朴な二段splice実装にありがちなオフバイワンを回避している。
- **Clearボタン新設**: タイムライン全体をクリアする専用ボタン（`videoEditConfirmClear`で確認ダイアログ表示）。
- **上部「動画ソース」パネルとの連携**: 自動連携ではなく、Video Sourceパネルに明示的な「Editに追加」ボタン(`#wfm-video-source-add-to-edit`)を新設。Frame/GIF目的の単発動画ドロップでEditタイムラインが意図せず汚れないよう、ユーザーが選択・確認済み。ローカルFile/サーバー参照(`kind:"local"`/`"input"`/`"output"`)の両方に対応し、クリックでEditサブタブへ自動切替。
- Frame抽出・GIF化（右ペイン、単独動画操作）とEdit（タイムライン編集・結合、複数クリップ操作）の役割分担は従来通り変更なし——ユーザーからの確認事項としてこの分離を維持している。

実機（ComfyUI_5・ポート8189、Kapture）で以下を確認済み: 左詰めタイムライン描画、Asset選択→「Editに追加」経路、2クリップの◀移動での順序入れ替え、複製、削除、クリア（確認ダイアログのi18n適用含む）、クリア後の単一クリップ書き出し（22.13秒で正常出力）。

## 7. レイアウト修正（2026-09-16、追加指示）

UI再設計直後、実機で「空のタイムライン/書き出しパネルが中央に縮んで表示され、Planタブのように横幅いっぱい・右端固定にならない」という不具合をユーザーが発見。原因はCSSのバグで、修正内容は以下の3点。

1. **Editタブ自身のドロップゾーンを削除**: `#wfm-video-edit-drop-zone`をtemplates/index.htmlから削除し、`video-edit-tab.js`の`_wireAddClipDropZone()`も削除。クリップ追加は Asset タブの「Editへ送る」ボタンと、Video Sourceパネルの「Editに追加」ボタン（第4節参照）の2経路に一本化。
2. **【根本原因】`static/css/video-tab.css`に旧プレースホルダー時代の重複`.wfm-video-edit-panel`ルールが残存していた。** Edit サブタブが「Editing tools coming soon」という1行プレースホルダーだった頃の`display:flex; align-items:center; justify-content:center; border:1px dashed ...`というルール（中央に1行だけ表示するための定義）が、実装を追加した後も削除されておらず、CSSカスケード順（後勝ち）で新しい`.wfm-video-edit-panel { padding: 0 16px 16px; }`の直後に来て`align-items:center`等を上書きし続けていた。これによりタイムライン・トリムパネル・書き出しパネルの全てが横方向に縮んで中央寄せされていた。該当ルールを完全に削除して解消。
3. `.wfm-video-edit-timeline-track`に`width:100%; box-sizing:border-box; flex:none;`を明示し、クリップの有無に関わらずトラック自体がPlanの`.wfm-video-timeline-track`と同様に横幅いっぱい・高さ固定のバーであり続けるようにした（今回のバグの根本原因はCSSの重複ルールだったが、将来の再発防止として明示指定を追加）。

修正後、実機で「空のタイムラインが横幅いっぱいに固定表示される」「クリップ追加後もトラックがフル幅を保ち、クリップは左詰め」「書き出しパネルがPlanのRun/Planパネルと同じ右端固定位置に表示される」ことをスクリーンショットで確認済み。

## 8. トリムパネル・ツールバーの細部調整（2026-09-16、追加指示）

- **開始/終了(秒)入力欄+「現在位置を使用」ボタン**: 従来は横並び(`display:flex`)で、ボタンのテキストが枠からはみ出しコンテナ幅を超えていた。入力欄とボタンを縦積み(`.wfm-video-edit-trim-field { flex-direction:column }`)にし、`.wfm-video-edit-trim-row`のグリッド列幅を`minmax(0,160px)`に縮小。ボタンは`.wfm-video-edit-playhead-btn`（font-size:10px、padding:2px 6px）で一回り小さくし、入力欄との見分けを明確化。
- **タイムライン総合時間の表示**: ツールバーのClearボタン左隣に、全クリップのトリム後長さ合計を表示する`#wfm-video-edit-total-duration`(`合計: 22.1s`のような表示)を追加。`_updateTotalDuration()`が`_updateToolbarState()`（タイムライン再描画のたびに呼ばれる）から自動更新される。

## 9. タイムライン連続プレビュー（2026-09-16、追加指示）

「タイムラインの動画を上部の『生成された動画』プレビューで表示したい。このプレビューの動画＝書き出しされる動画としたい」という要望に対応。新規に`<video>`要素を追加するのではなく、Exportの結果が最終的に書き出される**同じ「Result」プレビュー枠**(`#wfm-video-preview-video`、`video-preview.js`の`setResultPreview()`が使う枠)を共有し、タイムライン上の全クリップ（トリム区間反映済み）を順番に連続再生する「疑似合成プレビュー」を実装した。当初計画のMVP項目4「各クリップを順番に`<video>`要素で連続再生する疑似プレビュー」を正式に実装したものにあたる。

- **UI**: タイムラインツールバーに「▶ プレビュー / ■ 停止」トグルボタンを追加（Delete と 合計時間表示の間）。クリップが0件のときは無効化。
- **実装**（`video-edit-tab.js`）: `_startPreview()`が`serverRef`ありかつエラー無しのクリップを`_previewClips`として捕捉し先頭から`setResultPreview()`で読み込み・`trimStart`へシーク・再生。`timeupdate`イベントで`currentTime >= trimEnd`を検知した時点、または`ended`イベントで次クリップへ自動遷移（`_advancePreview()`）。全クリップ終了で自動停止。
- `video-preview.js`に`getResultPreviewVideoElement()`を新規export（Resultペインの`<video>`要素へ直接アクセスし、`timeupdate`/`ended`購読や`currentTime`制御を行うため。`setResultPreview()`自体はsrc差し替えのみで再生制御はできないため）。
- クリップ削除・クリア・書き出し開始時には`_stopPreview()`を呼び、再生中の疑似プレビューを確実に停止する（書き出し完了後は同じ枠に実際の書き出し結果が上書き表示される——「プレビューの動画＝書き出しされる動画」という要望通り、同一枠が編集中プレビューと最終結果の両方を担う）。

実機で2クリップ(22.1s+19.1s)の連続プレビュー再生→クリップ境界での自動切替→停止→書き出し(結合後41.2s)→Resultペインへの結果反映、という一連の流れを確認済み。

---

### Critical Files for Implementation
- static/js/video-edit-tab.js（新規、中心となるクラス実装）
- templates/index.html（Edit subtab DOM骨格、2895行目付近を拡張）
- static/js/video-workflow.js（ノード注入・ID採番パターンの流用元）
- py/services/video_service.py（probe_video/overlay_text_on_video追加）
- py/routes/video_routes.py（新規APIエンドポイント追加）
- static/js/image-edit-tab.js（アクションバー・レイヤーパネル・pointerイベントパターンの流用元、1385行目・2194行目・1130-1249行目）
- static/js/video-asset-tab.js（Asset→Edit連携ボタン追加）
