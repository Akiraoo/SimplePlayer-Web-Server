# Simple Player Web Server

Simple Player 的自架音樂串流 Web Server。

提供音樂掃描、Metadata、封面、歌詞、播放清單、Web Player，以及供 Android Client 使用的 Mobile API。

## 功能

* 音樂資料夾自動掃描
* 支援子資料夾與資料夾式播放清單
* 讀取音樂檔案 Metadata
* 嵌入式封面與歌詞
* Metadata / Cover 快取
* Web Player
* Mobile API
* Android Client 支援
* M4A 自動轉碼為 FLAC 串流
* 支援區域網路存取
* 可搭配反向代理與 DDNS 使用

## 支援格式

MP3、FLAC、M4A、AAC、OGG / OGA、Opus、WAV、WebM。

其中 M4A 會在第一次播放時由 FFmpeg 轉碼為 FLAC 再串流，轉好的檔案會快取起來，之後播放不需要再轉；其他格式直接以原檔串流。

## Requirements

* Windows（`start.bat` 為 Windows 批次檔；`server.js` 本身可在 Linux / macOS 執行，見下方說明）
* Node.js（建議使用 LTS 版本）
* FFmpeg（需加入 PATH，用於 M4A 轉碼）
* 一個存放音樂檔案的資料夾

FFmpeg 可用以下任一方式安裝：

```powershell
winget install Gyan.FFmpeg
```

```powershell
choco install ffmpeg
```

安裝後請重新開啟終端機，並以 `ffmpeg -version` 確認可以執行。`start.bat` 啟動時若找不到 FFmpeg 會顯示提示並結束。

## 使用方式

1. 下載或 Clone 本專案。
2. 將 `config.example.json` 複製一份並命名為 `config.json`，依需要修改音樂資料夾等設定。

   也可以略過這一步，直接執行 `start.bat`，Server 第一次啟動時會自動產生預設的 `config.json`（音樂資料夾為專案內的 `Music`）。
3. 執行：

```
start.bat
```

`start.bat` 會檢查 FFmpeg、自動處理 Node.js 套件安裝，並啟動 Simple Player Server，不需要另外手動執行 `npm install`。

### Linux / macOS

```bash
npm install
node server.js
```

## 設定檔 `config.json`

所有設定都集中在專案根目錄的 `config.json`。

第一次啟動時如果檔案不存在，Server 會自動建立一份預設值（內容與 `config.example.json` 相同）。

`musicDir` 與 `cacheDir` 的相對路徑一律以 `server.js` 所在資料夾為基準，從哪個目錄啟動 Server 結果都相同。欄位留空或不存在時使用預設值。

如果 `config.json` 格式錯誤，Server 會在終端機顯示警告並以預設值啟動，**不會**覆寫你的設定檔，修正後重新啟動即可。

```json
{
  "musicDir": "Music",
  "cacheDir": ".metadata-cache",
  "publicOrigin": ""
}
```

| 欄位             | 說明                                                                          | 留空時的行為                              |
| -------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| `musicDir`     | 音樂資料夾路徑。可以是相對路徑（相對於 `server.js`）或絕對路徑                                       | 使用 `Music`                           |
| `cacheDir`     | Metadata 與封面快取資料夾                                                            | 使用 `.metadata-cache`                |
| `publicOrigin` | 對外的公開網址，例如 `https://music.example.com`。用於分享頁的 OGP / Twitter meta 絕對 URL | 分享頁使用瀏覽器請求的 Host 產生網址（反向代理時會依 `X-Forwarded-Proto` 判斷 https） |

環境變數 `PUBLIC_ORIGIN` 若存在，會**覆寫** `config.json` 的 `publicOrigin`，方便臨時執行或 CI 使用：

PowerShell：

```powershell
$env:PUBLIC_ORIGIN="https://other.example.com"; node server.js
```

命令提示字元（cmd）：

```bat
set "PUBLIC_ORIGIN=https://other.example.com" && node server.js
```

Linux / macOS：

```bash
PUBLIC_ORIGIN=https://other.example.com node server.js
```

## 預設連接埠

開源版本預設使用：

| 功能         | Port |
| ---------- | ---: |
| Web Server | 8787 |
| Mobile API | 8788 |

Web Player：

```
http://localhost:8787
```

Mobile API：

```
http://localhost:8788
```

如果需要從其他裝置存取，請使用執行 Simple Player Server 的電腦在區域網路中的 IP。

例如：

```
http://192.168.0.100:8787
```

Android Client 則使用：

```
http://192.168.0.100:8788
```

請依實際網路環境修改 IP。

## Client 設定探索 `/api/config`

Mobile API 提供一個唯讀端點，讓 Client 得知伺服器的公開資訊：

```
GET /api/config
```

回應：

```json
{
  "publicOrigin": "https://music.example.com",
  "webPort": 8787,
  "mobileApiPort": 8788
}
```

`publicOrigin` 為空字串時代表此伺服器為純 LAN 部署。

Android Client 會讀取這個端點，並在 `publicOrigin` 為空時自動以使用者輸入的 API 位址代替。

## Metadata Cache

Simple Player 會在伺服器端建立 Metadata Cache，以避免每次啟動或掃描時都重新解析所有音樂檔案。

Cache 也會保存封面及其他必要資料。

伺服器的 Cache 不會取代原始音樂檔案，刪除 Cache 不會刪除音樂。

Cache 預設位於 `.metadata-cache/`（可用 `cacheDir` 修改）：

| 資料夾         | 內容                    |
| ----------- | --------------------- |
| `metadata/` | 每首歌的標題、歌手、專輯與歌詞       |
| `covers/`   | 從音樂檔案取出的封面            |
| `m4a-flac/` | M4A 轉碼後的 FLAC 檔       |

整個 `.metadata-cache/` 可以隨時刪除，Server 下次啟動時會重新建立。`m4a-flac/` 會隨著播放過的 M4A 越來越大，可以定期清理，被刪掉的檔案會在下次播放時重新轉碼。

Android Client 另外維護一份裝置本地的 Metadata Cache，兩者互相獨立：

```
Android Client
    │
    ├── Local Metadata Cache
    │
    ▼
Simple Player Mobile API
    │
    ├── Server Metadata Cache
    └── Music Files
```

## Android Client

本專案可以搭配 Simple Player Android Client 使用。

Android Client：

[SimplePlayer-android-app](https://github.com/Akiraoo/SimplePlayer-android-app)

Android Client 透過 Mobile API 與本 Server 通訊。

請注意 Android 裝置上的 `localhost` / `127.0.0.1` 指的是**手機本身**，不是執行 Simple Player Server 的電腦。

因此使用 Android Client 時，通常需要填入伺服器電腦的 LAN IP，例如：

```
http://192.168.0.100:8788
```

## 分享頁

Web Player 提供以下分享與下載連結：

| 路徑              | 用途                                |
| --------------- | --------------------------------- |
| `/s/<trackId>`  | 單曲分享頁，含播放器、歌詞、OGP meta            |
| `/p/<playlist>` | 播放清單分享頁，含播放器、歌詞、歌曲選擇面板           |
| `/d/<trackId>`  | 直接下載連結（`Content-Disposition: attachment`） |

若設定了 `publicOrigin`，分享頁的 `og:url`、`og:image` 會使用絕對網址，方便在 Discord、Twitter 等平台正確展開預覽卡片。未設定時會使用瀏覽器請求的 Host 產生絕對網址，經過反向代理時會依 `X-Forwarded-Proto` 判斷是否為 https。

## 反向代理

Simple Player 可以搭配 Nginx、Cloudflare 或其他反向代理使用。

如果需要從 Internet 存取，建議使用 HTTPS 與反向代理，而不是直接將 Node.js Server Port 暴露到公網。

若使用反向代理，建議將 `publicOrigin` 設為對外的 HTTPS 網址，讓分享頁的 OGP meta 產生正確的絕對 URL。

範例 Nginx 設定：

```nginx
server {
    listen 443 ssl http2;
    server_name music.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Web Server（8787）同樣提供完整的 Mobile API，因此反向代理只需要轉發 8787 即可，不必另外對外開放 8788。

此時 Android Client 直接填入對外網址即可，例如：

```
https://music.example.com
```

## 安全性注意事項

Simple Player **沒有內建帳號或存取驗證**。任何能連到 Server 的人都可以瀏覽曲庫、播放與下載歌曲，以及觸發重新掃描。

* 只在區域網路使用時，請勿在路由器上對外開放 8787 / 8788 Port。
* 需要從外部存取時，建議透過 VPN（例如 Tailscale、WireGuard），或在反向代理層加上存取控制（例如 Cloudflare Access）。
* `POST /api/scan` 在 10 秒內重複呼叫會直接回傳上一次的掃描結果（回應帶有 `"cached": true`），避免被連續觸發造成負載。

## 專案結構

主要元件：

```
SimplePlayer-Web-Server/
├── server.js
├── start.bat
├── config.json            (不進版本控制)
├── config.example.json
├── .gitignore
├── playlists.json         (不進版本控制)
├── package.json
├── public/
├── LICENSE
├── NOTICE
└── README.md
```

## License

本專案採用 **Apache License 2.0** 授權。

完整授權條款請參閱 Repository 根目錄的 `LICENSE`。

SPDX-License-Identifier：

```
Apache-2.0
```

## 相關專案

Android Client：

[SimplePlayer-android-app](https://github.com/Akiraoo/SimplePlayer-android-app)