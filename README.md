# CRPC Google MCP

東京大学医学部附属病院 臨床研究推進センター（CRPC）メンバー向けの、Claude Code から
自分の UTokyo アカウント（`@g.ecc.u-tokyo.ac.jp`）で Google を使うための MCP サーバー一式。

- **Drive**：読み取り（検索・ダウンロード・Sheets/Docs 読み取り）
- **Calendar**：読み取り
- **Gmail**：読み取り ＋ **下書き（ドラフト）作成**。※このサーバーには**送信機能はありません**（`create_draft` のみ）。

> ⚠️ **`credentials.json` はこのリポジトリには含まれません。** OAuth クライアント秘密情報を含むため、
> 管理者から CRPC 内限定チャネル（共有ドライブ／Box）で別途配布されます。公開リポジトリには絶対に置かないでください。

## 収録ファイル

| ファイル | 役割 |
|---|---|
| `auth-crpc.mjs` | Drive/Calendar/Gmail のスコープを 1 回の認証でまとめて取得し、単一トークンを生成 |
| `gdrive-wrapper.mjs` | Drive/Sheets/Forms MCP サーバー |
| `gcalendar-wrapper.mjs` | Calendar MCP サーバー |
| `gmail-wrapper.mjs` | Gmail MCP サーバー（読み取り＋ドラフト作成） |

外部依存はありません（Node.js 標準機能のみ）。Node.js v18 以上が必要です。

## セットアップ

### 1. clone

初回のみ。このリポジトリを `~/.config/gdrive-mcp` に配置します。

```bash
# macOS
git clone https://github.com/utokyo-crpc/gdrive-mcp.git ~/.config/gdrive-mcp
```

```powershell
# Windows (PowerShell)
git clone https://github.com/utokyo-crpc/gdrive-mcp.git "$env:USERPROFILE\.config\gdrive-mcp"
```

### 2. credentials.json を配置

管理者から受け取った `credentials.json` を、clone したフォルダ（`~/.config/gdrive-mcp/`）に置きます。

### 3. 認証

```bash
# macOS
node ~/.config/gdrive-mcp/auth-crpc.mjs
```

```powershell
# Windows
node "$env:USERPROFILE\.config\gdrive-mcp\auth-crpc.mjs"
```

ブラウザで **自分の `@g.ecc.u-tokyo.ac.jp` アカウント**を選び同意すると、
`.google-credentials-utokyo.json` が生成されます。`✅ 認証成功！` と出れば OK。

### 4. Claude Code に 3 サーバーを登録

`<本人のメール>` を自分のアドレスに置き換えて実行します。

```bash
# macOS / Linux
claude mcp add --scope user gdrive-utokyo \
  -e "GDRIVE_OAUTH_PATH=$HOME/.config/gdrive-mcp/credentials.json" \
  -e "GDRIVE_CREDENTIALS_PATH=$HOME/.config/gdrive-mcp/.google-credentials-utokyo.json" \
  -e "GDRIVE_ACCOUNT_LABEL=UTokyo (<本人のメール>)" \
  -- node "$HOME/.config/gdrive-mcp/gdrive-wrapper.mjs"

claude mcp add --scope user gcal-utokyo \
  -e "GCAL_OAUTH_PATH=$HOME/.config/gdrive-mcp/credentials.json" \
  -e "GCAL_CREDENTIALS_PATH=$HOME/.config/gdrive-mcp/.google-credentials-utokyo.json" \
  -e "GCAL_ACCOUNT_LABEL=UTokyo (<本人のメール>)" \
  -- node "$HOME/.config/gdrive-mcp/gcalendar-wrapper.mjs"

claude mcp add --scope user gmail-utokyo \
  -e "GMAIL_OAUTH_PATH=$HOME/.config/gdrive-mcp/credentials.json" \
  -e "GMAIL_CREDENTIALS_PATH=$HOME/.config/gdrive-mcp/.google-credentials-utokyo.json" \
  -e "GMAIL_ACCOUNT_LABEL=UTokyo (<本人のメール>)" \
  -- node "$HOME/.config/gdrive-mcp/gmail-wrapper.mjs"
```

```powershell
# Windows (PowerShell)  ※行末はバッククォート `
claude mcp add --scope user gdrive-utokyo `
  -e "GDRIVE_OAUTH_PATH=$env:USERPROFILE\.config\gdrive-mcp\credentials.json" `
  -e "GDRIVE_CREDENTIALS_PATH=$env:USERPROFILE\.config\gdrive-mcp\.google-credentials-utokyo.json" `
  -e "GDRIVE_ACCOUNT_LABEL=UTokyo (<本人のメール>)" `
  -- node "$env:USERPROFILE\.config\gdrive-mcp\gdrive-wrapper.mjs"

claude mcp add --scope user gcal-utokyo `
  -e "GCAL_OAUTH_PATH=$env:USERPROFILE\.config\gdrive-mcp\credentials.json" `
  -e "GCAL_CREDENTIALS_PATH=$env:USERPROFILE\.config\gdrive-mcp\.google-credentials-utokyo.json" `
  -e "GCAL_ACCOUNT_LABEL=UTokyo (<本人のメール>)" `
  -- node "$env:USERPROFILE\.config\gdrive-mcp\gcalendar-wrapper.mjs"

claude mcp add --scope user gmail-utokyo `
  -e "GMAIL_OAUTH_PATH=$env:USERPROFILE\.config\gdrive-mcp\credentials.json" `
  -e "GMAIL_CREDENTIALS_PATH=$env:USERPROFILE\.config\gdrive-mcp\.google-credentials-utokyo.json" `
  -e "GMAIL_ACCOUNT_LABEL=UTokyo (<本人のメール>)" `
  -- node "$env:USERPROFILE\.config\gdrive-mcp\gmail-wrapper.mjs"
```

### 5. 確認

```bash
claude mcp list
```

`gdrive-utokyo` / `gcal-utokyo` / `gmail-utokyo` が **Connected** になれば完了です。

## 秘書の仕組み（planner）を使う人だけ

planner は作業用の文書（Google ドキュメント）へ2週間の予定を転記し、前日分を記録用の文書へ移すので、ドキュメントを書き換える権限が要ります。MCP のトークンは読み取り専用のまま残し、Google ドキュメントの読み書きだけを持つトークンを別のファイルに取ります。

```bash
node ~/.config/gdrive-mcp/auth-crpc.mjs --docs
```

`.google-credentials-utokyo-docs.json` ができます。MCP には登録しません。planner の設定（`assistant.json` の `workDoc`・`logDoc` の `credential`）から指します。

## 更新

```bash
cd ~/.config/gdrive-mcp && git pull
```

スコープが変わった場合（例：Gmail ドラフト機能の追加）は、`git pull` 後に
`node auth-crpc.mjs` を再実行して同意し直してください。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `claude mcp list` で Failed | フォルダに `credentials.json` と `.google-credentials-utokyo.json` の両方があるか確認。無ければ手順 2・3 をやり直す |
| Gmail の下書き作成でエラー | `node auth-crpc.mjs` を再実行し、同意画面で **Gmail の管理** 権限にチェックが入っているか確認 |
| しばらく後にアクセス不可（稀） | フォルダで `node auth-crpc.mjs` を再実行 |

## セキュリティ

- 各メンバーは**自分の g.ecc アカウント**で認証し、トークンは各自の PC のローカル（`~/.config/gdrive-mcp/`）にのみ保存されます。他メンバーと競合しません。
- `credentials.json`・生成されるトークンは `.gitignore` 済み。**公開リポジトリにコミットしないでください。**
- スコープは Drive/Calendar 読み取り、Gmail 読み取り＋ドラフト作成のみ。**メール送信・ファイル書き込みはできません。**

---

*管理: 齋藤俊樹（CRPC センター長）／ 配布方式: Route B（Claude Code + ローカル MCP）*
