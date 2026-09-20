# 急救車盤點・靜態表單

線上網址：<https://kunjulin.github.io/crashcart-web/>

護理師掃急救車上的 QR code 就會開這個頁面。不需要登入，不需要 App。

## 這裡有什麼

| 檔案 | 做什麼 |
|---|---|
| `index.html` | 入口頁。顯示這台急救車，選要填哪一張表。 |
| `periodic.html` | **附件九・定期點班**。38 個品項 × 4 個面向。 |
| `rules.json` | **16 條異常規則**。前端紅字和後端 Flow-2 讀同一份。 |
| `rules.js` | 判定引擎。只負責「怎麼算」，門檻值都從 `rules.json` 來。 |
| `scanner.js` | **掃條碼共用入口**（`CCScan.open`）。三張表都用它。 |
| `vendor/` | 掃條碼的後備解碼器。**不要手改**，是從 npm 複製進來的。 |
| `api.js` | 跟 Power Automate 說話的那一層。 |
| `config.json` | Flow-1 / Flow-2 的網址。 |
| `demo-context.json` | 示範資料，讓還沒接流程也能看畫面。 |
| `app.css` | 版面。手機優先。 |

## 怎麼在本機看

```bash
python -m http.server 5180 --directory web
```

然後開 <http://localhost:5180/periodic.html?demo=1>。

`?demo=1` 是示範模式：資料是假的，送出不會存進 SharePoint。

## 掃條碼怎麼運作

護理師掃員工證上的一維條碼填員工編號。程式在 `scanner.js`：

```
按下「掃條碼」
      ↓
有原生 BarcodeDetector？（Android Chrome 有）
  有 → 直接用，最快
  沒有（iPhone Safari、Windows 桌面 Chrome）
      ↓
載入 vendor/ 的後備解碼器（ZXing WebAssembly）
  ← 按下按鈕才載，不拖慢表單開啟
  ← 檔案都在自己站台，不連 CDN（醫院網路可能擋外部網址）
```

`vendor/` 裡的兩個檔案是從 npm 複製進來的，**不要手改**：

| 檔案 | 來源 | 大小 |
|---|---|---|
| `barcode-detector.ponyfill.js` | `barcode-detector@3.2.2` 的 `dist/iife/ponyfill.js` | 43 KB |
| `zxing_reader.wasm` | `zxing-wasm@3.1.3` 的 `dist/reader/zxing_reader.wasm` | 1.04 MB |

要更新版本：

```bash
npm pack barcode-detector@<版本>
npm pack zxing-wasm@<版本>
```

解開後把那兩個檔案蓋過去。兩個版本要配對 —— `barcode-detector` 的
`dependencies.zxing-wasm` 寫的就是該用哪一版。

### 要改的兩個地方

`scanner.js` 最上面有兩個常數：

- `FORMATS` —— 限定要認哪幾種條碼。現在是 `code_39` 跟 `qr_code`。
  **長庚員工證是 code_39，值就是員工編號**（2026-09 實機確認）。
  `qr_code` 留著是為了認得出「你掃到急救車的 QR code 了」並告訴使用者；
  不認的話他只會一直掃不到，不知道哪裡錯。代價很小（單張解碼 8.8ms vs 6.0ms）。
- `DETECT_INTERVAL_MS` —— 多久掃一次。WebAssembly 解碼比原生慢很多，
  每個 frame 都跑會讓手機發燙又卡，所以節流到 150ms。

### 別的欄位也想掃？

`CCScan.open()` 是通用的，例如封簽鎖號碼：

```js
CCScan.open({
  title: '把封簽鎖上的條碼對準框內',
  onResult: function (text) { el('sealNumber').value = text; },
  onError: function (msg) { alert(msg); }
});
```

`validate` 可以傳一個函式，回傳一句話代表「這不是我要的東西」，
畫面不會關掉，會顯示那句話並繼續掃。員工編號用的是 `CCScan.employeeBadge`，
它擋掉長度超過 20 和含有 `://` 的值 —— 那多半是掃到急救車那張 QR code。

## 正式網址長什麼樣

```
https://kunjulin.github.io/crashcart-web/?cart=CC-8A-01&t=<QR token>
```

`t` 是那台急救車專屬的通行證，印在 QR code 裡。真實的 token 不會進版控。

## 關於安全

這個 repo 是**公開**的，所以：

- **不可以**放 QR token、員工名冊、任何病人資料。
- `config.json` 裡的流程網址雖然帶簽章，但任何打開頁面的人都看得到，
  所以我們不當它是秘密。真正的防線在後端：
  1. Flow-1 / Flow-2 一定要帶對的 QR token。
  2. 每次送出都記錄來源 IP、User-Agent、token 前 8 碼。
  3. 同一台車短時間內不接受重複送出。
  4. 所有寫入都有版本紀錄與稽核軌跡。
- 查員工姓名是**一次查一個**，不把整個單位的名冊送到前端。

## 這個 repo 怎麼來的

它是主 repo <https://github.com/kunjulin/PACrashCart>（私有）裡 `web/` 資料夾的分身。
**請不要直接在這裡改**，改了會在下次同步時被蓋掉。

主 repo 同步指令：

```bash
git subtree push --prefix=web web main
```
