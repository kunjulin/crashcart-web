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
