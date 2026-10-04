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
* M4A / AAC 等格式轉碼為 FLAC
* Discord Rich Presence
* 支援區域網路存取
* 可搭配反向代理與 DDNS 使用

## Requirements

* Windows
* Node.js
* 一個存放音樂檔案的資料夾

建議使用 Node.js 的 LTS 版本。

## 使用方式

將專案下載或 Clone 後，設定好音樂資料夾與其他必要設定。

直接執行：

```text
start.bat
```

`start.bat` 會自動處理 Node.js 套件安裝並啟動 Simple Player Server。

不需要另外手動執行 `npm install`。

## 預設連接埠

開源版本預設使用：

| 功能         | Port |
| ---------- | ---: |
| Web Server | 8787 |
| Mobile API | 8788 |

Web Player：

```text
http://localhost:8787
```

Mobile API：

```text
http://localhost:8788
```

如果需要從其他裝置存取，請使用執行 Simple Player Server 的電腦在區域網路中的 IP。

例如：

```text
http://192.168.0.100:8787
```

Android Client 則使用：

```text
http://192.168.0.100:8788
```

請依實際網路環境修改 IP。

## Metadata Cache

Simple Player 會在伺服器端建立 Metadata Cache，以避免每次啟動或掃描時都重新解析所有音樂檔案。

Cache 也會保存封面及其他必要資料。

伺服器的 Cache 不會取代原始音樂檔案，刪除 Cache 不會刪除音樂。

## Android Client

本專案可以搭配 Simple Player Android Client 使用。

Android Client：

[SimplePlayer-android-app](https://github.com/Akiraoo/SimplePlayer-android-app?utm_source=chatgpt.com)

Android Client 透過 Mobile API 與本 Server 通訊。

請注意 Android 裝置上的 `localhost` / `127.0.0.1` 指的是**手機本身**，不是執行 Simple Player Server 的電腦。

因此使用 Android Client 時，通常需要填入伺服器電腦的 LAN IP，例如：

```text
http://192.168.0.100:8788
```

## Discord Rich Presence

Simple Player 可以透過 Discord Rich Presence 顯示目前播放的音樂。

如果要使用 Discord RPC，請依照自己的 Discord Application 設定：

* Discord Application ID
* Discord Application Secret
* OAuth2 Redirect URI

`DISCORD_REDIRECT_URI` 必須與 Discord Developer Portal 中設定的 Redirect URI 完全一致。

請不要將自己的 Discord Secret 或其他私人憑證提交到公開 Repository。

## 反向代理

Simple Player 可以搭配 Nginx、Cloudflare 或其他反向代理使用。

如果需要從 Internet 存取，建議使用 HTTPS 與反向代理，而不是直接將 Node.js Server Port 暴露到公網。

## 專案結構

主要元件：

```text
SimplePlayer-Web-Server/
├── server.js
├── start.bat
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

```text
Apache-2.0
```

## 相關專案

Android Client：

[SimplePlayer-android-app](https://github.com/Akiraoo/SimplePlayer-android-app?utm_source=chatgpt.com)
