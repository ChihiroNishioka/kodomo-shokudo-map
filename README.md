# 子ども食堂マップ

今いる場所から近い子ども食堂を、スマートフォンで探すための静的サイトです。サーバーは要りません。データは閲覧専用で、この画面から施設情報は編集できません。

掲載しているのは、二次利用できるオープンデータだけです。

- 東京都オープンデータカタログの「子ども食堂一覧」（**CC BY 4.0**）がある14区
- 神奈川県オープンデータカタログの「子ども食堂一覧」（カタログ上の表記は **クリエイティブ・コモンズ-表示 (CC BY)**。公表の同意が得られた食堂）のうち川崎市

千代田区、中央区、港区、新宿区、墨田区、世田谷区、北区、足立区、江戸川区は、東京都オープンデータカタログに子ども食堂一覧がありませんでした。区の公式ページはオープンデータ利用規約の対象外で、転載してよいか確認できないため、自動では取っていません。むすびえの全国データと、かわさきこども食堂ネットワークのサイトも、再利用の許諾を確認できないため使っていません。

このアプリは上記のオープンデータを加工しています。原データに緯度経度が無い会場は国土地理院の住所検索で座標を付け、個人宅・住所非公開・番地が無い行は除いています。マンションの部屋番号は表示から外しています。取得日は 2026-10-18 です。

2026-10-18 時点の件数は、掲載 **381**（番地まで一致 344、町名までの概位 37）、除外 **52** です。除外の内訳は、住所非公開 7、番地が無い・「周辺」のみ 5、名称なし 1、個人宅 4、中野区の区役所住所がプレースホルダになっている行 32、町名が無くジオコーディングできない行 1（豊島区「2-63-4」）、住所そのものが無い行 2 です。豊島区は同じデータセットが2ファイルあり、杉並区に同一会場の重複行があるため、入力行数と掲載＋除外の合計は一致しません。

住所の補修は次だけです。区名が二度続いているものは一つにする。データセットの市区町村名が住所から抜けているときは補う。渋谷区のCSVは代々木を「代-木」と書いていて、読みがヨヨギなので代々木に戻す。国土地理院の応答が町名止まりのときは、返ってきた町・字を足して一度だけ再検索する（前野→前野町、代官山→代官山町）。

## 画面

- 現在地を地図の中心にします。取れないときは東京都庁を中心に、再試行ボタンを出します。
- ピンをタップすると詳細が出ます。同じピンをもう一度タップするか、地図の空白をタップすると閉じます。
- 右下の + / − でズームします。
- スマートフォンでは、地図の移動は二本指です。一本指では地図は動きません。
- 一覧は現在地（取れないときは東京都庁）からの直線距離が近い順です。
- 開催曜日と対象で絞り込めます。外れたピンは地図上で薄くなり、一覧からは外れます。
- 詳細から Google マップの経路を開けます。
- 「開催日・開催時間は変更される場合があります。訪問前に必ず施設・自治体にご確認ください。」を常に表示します。

## 起動

```bash
python3 -m http.server 47321 --bind 127.0.0.1
```

ブラウザで <http://127.0.0.1:47321> を開きます。位置情報は HTTPS か localhost でだけ動きます。

## テスト

```bash
npm ci
npx playwright install --with-deps chromium
npm test
```

モバイル幅（390×844、deviceScaleFactor 3）で、初期表示、ピンタップ前、ピンタップ後、位置情報が取れないときの画面を撮ります。テスト中の地図タイルは `tests/fixtures/tile.png` に置き換えます。実タイルで撮るときは `MOCK_TILES=0 npm test` です。

## データを差し替える

配信用は `data/facilities.json` です。`data/config.json` の `dataSource` を別のパスや URL に変えると、読み込み先が変わります。項目は次のとおりです。

- `id`, `name`, `is_sample`（実データは `false`）
- `address.prefecture`, `address.city`, `address.detail`, `address.location_precision`（`exact` または `approximate`）
- `lat`, `lng`
- `schedule.frequency_text`, `schedule.weekdays`（`mon`〜`sun`）, `schedule.time_text`, `schedule.notes`
- `target`（`child` / `family` / `senior` / `anyone`）
- `fee_text`, `contact.phone`, `contact.url`（無いときは `"未確認"`）
- `source.provider`, `source.license`, `source.last_verified`

再生成は次です。未キャッシュの住所だけ国土地理院の住所検索 API を、1件あたり約0.7秒空けて呼びます。

```bash
python3 -m pip install -r requirements.txt
python3 scripts/build_facilities.py
```

入力ファイルは `data/raw/`、座標のキャッシュは `data/geocode-cache.json`、載せなかった行の理由は `data/exclusions.json` です。個人宅と住所非公開の行は、住所を exclusions に残しません。

## 地図タイル

標準は OpenStreetMap です。アクセスが増えたら `data/config.json` の `tileProvider` を `gsi` にすると地理院タイルに切り替わります。地理院タイルの出典はアプリ内の帰属表示に出します。

## GitHub Pages

`.github/workflows/deploy.yml` がテストのあと、`actions/upload-pages-artifact` と `actions/deploy-pages` で公開します。リポジトリの Settings → Pages → Source を GitHub Actions にしてください。公開 URL は `https://<user>.github.io/kodomo-shokudo-map/` です。ファイル参照は相対パスなので、サブパスでも動きます。

## 第三者のライセンス

- Leaflet 1.9.4（BSD-2-Clause）: `vendor/leaflet/`
- Leaflet.GestureHandling 1.1.8（MIT、elmarquis）: `vendor/leaflet-gesture-handling/`
- 施設データ: 各区の CC BY 4.0、川崎市分は神奈川県の CC BY。出典リンクはアプリの「出典とライセンス」にあります。
- 座標の補完: 国土地理院 住所検索
- 背景地図: © OpenStreetMap または 地理院タイル
