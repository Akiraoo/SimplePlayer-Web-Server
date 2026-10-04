# Simple Player

一個自架的音樂播放器，提供 Web Player、Mobile API、Discord Rich Presence，以及音樂 metadata、封面快取與轉碼功能。

## Features

* 🎵 Web Player
* 📁 自動掃描音樂資料夾及子資料夾
* 📝 音樂 Metadata
* 🖼️ 封面快取
* 🎶 Playlist
* 📱 Mobile API
* 🔄 音訊轉碼
* 🎮 Discord Rich Presence
* 🌐 支援 LAN、DDNS、Reverse Proxy
* 💾 Metadata / Cover / Transcode 快取
* 🚀 不需要將音樂複製到專案目錄

---

## Requirements

### Server

* Windows
* Node.js

第一次使用時**不需要手動安裝 Node.js modules**。

專案提供 `start.bat`，會自動處理必要的 Node.js dependencies 並啟動 Simple Player。

---

# Installation & Start

將整個專案放到任意位置，例如：

```text
D:\SimplePlayer
```

然後直接執行：

```text
start.bat
```

`start.bat` 會自動：

1. 檢查 Node.js
2. 安裝 / 準備所需的 Node.js modules
3. 啟動 Simple Player

因此一般使用者不需要手動執行：

```powershell
npm install
```

或：

```powershell
node server.js
```

之後再次使用時，同樣直接執行：

```text
start.bat
```

即可。

> 如果系統沒有 Node.js，請依 `start.bat` 顯示的提示安裝對應版本。

---

# Configuration

Simple Player 使用設定檔指定音樂與快取位置。

例如：

```json
{
    "musicDir": "F:\\Music",
    "cacheDir": "G:\\.metadata-cache"
}
```

### `musicDir`

音樂資料夾。

Simple Player 會掃描此資料夾以及所有子資料夾。

例如：

```text
F:\Music
├─ Artist A
│  ├─ Album 1
│  │  ├─ 01 - Song.flac
│  │  └─ 02 - Song.flac
│  └─ Album 2
│     └─ Song.mp3
└─ Artist B
   └─ Song.flac
```

### `cacheDir`

快取資料夾。

例如：

```text
G:\.metadata-cache
```

程式會在其中建立：

```text
metadata/
covers/
m4a-flac/
```

等快取目錄。

---

# Starting Simple Player

正常情況下只需要：

```text
start.bat
```

啟動後，終端機會顯示目前的 Server 狀態，例如：

```text
Simple Player
Music dir: F:\Music
Cache dir: G:\.metadata-cache
Local: http://localhost:50000
Tracks: 1761
LAN: http://192.168.0.219:50000
Mobile API: http://localhost:55555
Mobile API listening on 0.0.0.0:55555
```

實際 Port 及網址以目前版本啟動時顯示的內容為準。

---

# Web Player

在伺服器本機開啟：

```text
http://localhost:<WEB_PORT>
```

例如：

```text
http://localhost:50000
```

同一區域網路的其他裝置可以使用：

```text
http://<SERVER_LAN_IP>:<WEB_PORT>
```

例如：

```text
http://192.168.0.219:50000
```

如果其他裝置無法連線，請確認 Windows Firewall 是否允許對應 Port。

---

# Mobile API

Simple Player 提供 Mobile API 給 Android App 使用。

例如：

```text
Mobile API listening on 0.0.0.0:55555
```

伺服器本機：

```text
http://localhost:55555
```

LAN：

```text
http://<SERVER_LAN_IP>:55555
```

Android 不應使用：

```text
http://localhost:55555
```

因為 Android 上的 `localhost` 指的是 Android 裝置本身。

應使用伺服器的 LAN IP，例如：

```text
http://192.168.0.219:55555
```

---

# Android App

Android Client：

```text
Package: com.akira.simpleplayer
```

使用 Media3 處理播放。

將 Server / API URL 指向你的 Simple Player Server。

例如：

```text
http://192.168.0.219:55555
```

音樂不需要預先下載到手機。

---

# Playlist

Playlist 資料儲存在：

```text
playlists.json
```

位置為程式的工作目錄。

請不要隨意刪除或移動此檔案，否則可能造成 Playlist 資料遺失。

---

# Metadata & Cache

Simple Player 會掃描音樂並建立 metadata cache。

例如：

```text
Initial scan: 1761 tracks (1761 added, 0 changed, 0 removed)
```

快取位置：

```text
<cacheDir>
├─ metadata/
├─ covers/
└─ m4a-flac/
```

音樂檔案本身不會因為建立快取而被複製到這些目錄。

---

# Discord Rich Presence

Simple Player 支援 Discord Rich Presence。

Discord Application 必須由使用者自行建立。

## 1. 建立 Discord Application

前往 Discord Developer Portal：

https://discord.com/developers/applications

建立 Application 後取得：

* Application ID / Client ID
* Client Secret

---

## 2. Application ID

在 Simple Player 專案目錄建立：

```text
discord-app-id.txt
```

內容：

```text
YOUR_DISCORD_APPLICATION_ID
```

只放 ID，不需要引號。

---

## 3. Client Secret

建立：

```text
discord-app-secret.txt
```

內容：

```text
YOUR_DISCORD_CLIENT_SECRET
```

不要將這個檔案公開。

建議加入 `.gitignore`：

```gitignore
discord-app-id.txt
discord-app-secret.txt
```

---

# Discord Redirect URI

Redirect URI **不是固定值**，每個部署者都必須自行設定。

程式中：

```js
const DISCORD_REDIRECT_URI = 'https://(your url)';
```

修改成自己的網址，例如：

```js
const DISCORD_REDIRECT_URI = 'https://example.com/';
```

也可以使用自己的 DDNS / Domain：

```js
const DISCORD_REDIRECT_URI = 'https://music.example.com/';
```

然後在 Discord Developer Portal：

**OAuth2 → Redirects**

加入完全相同的 URL。

例如：

```text
https://music.example.com/
```

程式與 Discord Developer Portal 的 Redirect URI 必須完全一致，包括：

* `http` / `https`
* Domain
* Port
* Path
* 最後的 `/`

---

# Discord Configuration

目前 Discord 設定使用外部檔案：

```js
const DISCORD_CLIENT_ID =
    path.join(__dirname, 'discord-app-id.txt');

const DISCORD_CLIENT_SECRET_FILE =
    path.join(__dirname, 'discord-app-secret.txt');

const DISCORD_REDIRECT_URI =
    'https://(your url)';

const DISCORD_RPC_PIPES =
    Array.from(
        { length: 10 },
        (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`
    );
```

其中：

| 設定                       | 說明                         |
| ------------------------ | -------------------------- |
| `discord-app-id.txt`     | 自己的 Discord Application ID |
| `discord-app-secret.txt` | 自己的 Discord Client Secret  |
| `DISCORD_REDIRECT_URI`   | 自己的公開網址                    |
| `DISCORD_RPC_PIPES`      | Discord IPC，通常不需要修改        |

---

# DDNS / Reverse Proxy

Simple Player 可以搭配：

* DDNS
* Cloudflare
* Nginx
* Caddy
* 其他 Reverse Proxy

例如：

```text
Internet
   │
   ▼
https://music.example.com
   │
   ▼
Reverse Proxy
   │
   ▼
Simple Player
```

如果使用 HTTPS 公開服務，Discord Redirect URI 也應使用相同的 HTTPS 網址。

---

# Security

如果要將 Simple Player 公開到 Internet：

* 建議使用 HTTPS
* 建議使用 Reverse Proxy
* 不要公開 Discord Client Secret
* 不要將 `discord-app-secret.txt` 上傳到 Git
* 不要直接暴露不必要的 API Port
* 使用防火牆限制連線

---

# Troubleshooting

## `start.bat` 無法啟動

先確認系統可以使用 Node.js：

```powershell
node -v
```

如果 Node.js 不存在，依 `start.bat` 的提示安裝 Node.js。

---

## 音樂沒有出現

確認設定中的：

```text
musicDir
```

指向正確的音樂資料夾。

例如：

```text
F:\Music
```

啟動時應該能看到掃描結果：

```text
Initial scan: XXXX tracks
```

---

## Android 無法連線

確認：

1. PC 與手機位於同一個 LAN
2. Mobile API 正在監聽
3. Windows Firewall 沒有封鎖 API Port
4. Android 使用 PC 的 LAN IP

例如：

```text
http://192.168.0.219:55555
```

不要使用：

```text
http://localhost:55555
```

---

## Discord OAuth 錯誤

檢查：

```text
DISCORD_REDIRECT_URI
```

是否與 Discord Developer Portal 完全一致。

尤其注意：

```text
https://example.com
```

與：

```text
https://example.com/
```

也可能被視為不同的 Redirect URI。

---

# Project Structure

基本結構：

```text
SimplePlayer/
├─ server.js
├─ start.bat
├─ package.json
├─ public/
├─ playlists.json
├─ discord-app-id.txt
├─ discord-app-secret.txt
└─ ...
```

Discord Secret 等私人檔案請勿公開。

---

# Notes

* 一般使用者只需要執行 `start.bat`。
* `start.bat` 會自動處理 Node.js modules 並啟動 Server。
* 音樂資料夾可以位於專案目錄以外。
* Metadata、Cover、Transcode 可以使用獨立快取磁碟。
* Playlist 儲存在 `playlists.json`。
* Discord Application 由使用者自行建立。
* Discord Application ID 與 Client Secret 使用外部檔案保存。
* Discord Redirect URI 必須由使用者自行填寫。
* 不要將自己的 Discord Secret、設定檔或其他私人資訊提交到公開 Repository。
* 實際 Web / API Port 以啟動時顯示的資訊為準。
