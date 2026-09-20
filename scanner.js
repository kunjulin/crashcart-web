/*
 * 掃條碼共用入口。
 *
 * 為什麼要抽出來：
 *   附件七、八、九都要掃員工證，以後封簽鎖號碼可能也要掃。
 *   原本兩份程式各寫一次，改一個地方會忘了改另一個。
 *
 * 怎麼掃：
 *   有原生 BarcodeDetector（Android Chrome）就用原生的，最快。
 *   沒有（iOS Safari、Windows 桌面 Chrome）才載入 vendor/ 裡的後備解碼器。
 *   後備的是 1MB 的 WebAssembly，按下按鈕才載，不拖慢表單開啟。
 *   全部檔案都在自己站台上，不連 CDN —— 醫院網路可能擋外部網址。
 */
(function (global) {
  'use strict';

  /* ---------------- 可以調的常數 ---------------- */

  // 員工證的實際條碼格式還沒確認，先開這幾種。
  // 確認之後把用不到的刪掉，辨識會更快也更不容易認錯。
  var FORMATS = ['code_39', 'code_128', 'codabar', 'ean_13', 'qr_code'];

  var VENDOR = 'vendor/';
  var PONYFILL_SRC = VENDOR + 'barcode-detector.ponyfill.js?v=3.2.2';

  // WebAssembly 解碼比原生慢很多，每個 frame 都跑會讓手機發燙又卡。
  // 大約每 150ms 掃一次，對準條碼後不到一秒就會中。
  var DETECT_INTERVAL_MS = 150;

  // 員工編號不會超過這個長度。掃到更長的多半是急救車那張 QR code。
  var EMP_MAX_LEN = 20;

  /* ---------------- 後備解碼器 ---------------- */

  var fallbackPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('載入失敗：' + src)); };
      document.head.appendChild(s);
    });
  }

  /** 把訊息標記成「可以直接給護理師看」，跟程式內部的錯誤分開。 */
  function friendly(msg) {
    var e = new Error(msg);
    e.friendly = true;
    return e;
  }

  /** 載入後備解碼器，並把 .wasm 的位置指到自己站台的 vendor/。只會載一次。 */
  function loadFallback() {
    if (fallbackPromise) return fallbackPromise;
    fallbackPromise = loadScript(PONYFILL_SRC).then(function () {
      var api = global.BarcodeDetectionAPI;
      if (!api || !api.BarcodeDetector) throw new Error('後備解碼器沒有正確載入');

      // 不覆寫的話它會去 jsDelivr 抓 wasm，醫院網路可能擋。
      var overrides = {
        locateFile: function (path) { return VENDOR + path; }
      };
      if (typeof api.prepareZXingModule === 'function') {
        // 先把 wasm 抓下來，晚點掃的時候就不用等。
        return Promise.resolve(
          api.prepareZXingModule({ overrides: overrides, fireImmediately: true })
        ).then(function () { return api; });
      }
      api.setZXingModuleOverrides(overrides);
      return api;
    }).catch(function (e) {
      // 失敗就忘掉，下次按按鈕可以再試一次。
      fallbackPromise = null;
      if (global.console) console.error('[CCScan] 後備解碼器載入失敗', e);
      throw friendly('載不到掃碼元件，可能是網路不通。請直接打字輸入。');
    });
    return fallbackPromise;
  }

  /* ---------------- 取得一個解碼器 ---------------- */

  /** 原生的 BarcodeDetector 不一定每種格式都支援，先問過再建，免得建構式直接丟例外。 */
  function nativeDetector(formats) {
    var Ctor = global.BarcodeDetector;
    var ask = (typeof Ctor.getSupportedFormats === 'function')
      ? Ctor.getSupportedFormats()
      : Promise.resolve(formats);
    return Promise.resolve(ask).then(function (supported) {
      var use = formats.filter(function (f) { return supported.indexOf(f) >= 0; });
      return new Ctor(use.length ? { formats: use } : undefined);
    });
  }

  function getDetector(formats) {
    if ('BarcodeDetector' in global) {
      return nativeDetector(formats).catch(function () {
        // 原生的建不起來（有些瀏覽器只是掛個空殼）就改用後備的。
        return loadFallback().then(function (api) {
          return new api.BarcodeDetector({ formats: formats });
        });
      });
    }
    return loadFallback().then(function (api) {
      return new api.BarcodeDetector({ formats: formats });
    });
  }

  /* ---------------- 檢查掃到的值 ---------------- */

  /**
   * 員工證用的檢查。回傳一句話代表「這不是我要的東西」，回傳空字串代表可以用。
   * 護理師很容易對錯目標，掃到車上那張 QR code，那是一串網址。
   */
  function employeeBadge(text) {
    if (text.indexOf('://') >= 0) return '這是急救車的 QR code，不是員工證。請對準員工證上的條碼。';
    if (text.length > EMP_MAX_LEN) return '這不是員工證條碼。請對準員工證上的條碼。';
    return '';
  }

  /* ---------------- 畫面 ---------------- */

  function buildOverlay(title) {
    var root = document.createElement('div');
    root.setAttribute('data-cc-scan', '1');
    root.style.cssText =
      'position:fixed;inset:0;z-index:2000;background:#000;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center';

    var video = document.createElement('video');
    // iOS 少一個屬性就會整個跳去全螢幕播放器，掃不成。
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('autoplay', '');
    video.setAttribute('muted', '');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000';

    // 對準框，讓護理師知道要把條碼放哪裡。
    var frame = document.createElement('div');
    frame.style.cssText =
      'position:absolute;left:8%;right:8%;top:50%;transform:translateY(-50%);' +
      'height:26%;border:3px solid #fff;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.45)';

    var tip = document.createElement('div');
    tip.textContent = title || '把條碼對準框內';
    tip.style.cssText =
      'position:absolute;left:0;right:0;top:calc(env(safe-area-inset-top, 0px) + 16px);' +
      'text-align:center;color:#fff;font-size:1.05rem;font-weight:700;padding:0 16px;' +
      'text-shadow:0 1px 3px rgba(0,0,0,.8)';

    var status = document.createElement('div');
    status.style.cssText =
      'position:absolute;left:16px;right:16px;bottom:calc(env(safe-area-inset-bottom, 0px) + 92px);' +
      'text-align:center;color:#fff;font-size:1rem;line-height:1.5;' +
      'text-shadow:0 1px 3px rgba(0,0,0,.8)';

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.className = 'primary';
    cancel.style.cssText =
      'position:absolute;left:50%;transform:translateX(-50%);' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 24px);' +
      'min-width:160px;min-height:52px;font-size:1.1rem';

    root.appendChild(video);
    root.appendChild(frame);
    root.appendChild(tip);
    root.appendChild(status);
    root.appendChild(cancel);
    document.body.appendChild(root);

    return { root: root, video: video, status: status, cancel: cancel };
  }

  /* ---------------- 主入口 ---------------- */

  /** 這台裝置到底能不能掃。只有連相機都拿不到才算不能。 */
  function supported() {
    return !!(global.navigator && navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function');
  }

  /**
   * 開掃碼畫面。
   *
   * opts.onResult(text)  掃到而且通過檢查，畫面已經關掉。值已經 trim 並轉大寫。
   * opts.onError(msg)    開不了相機或載不到解碼器，畫面已經關掉。msg 是給護理師看的白話。
   * opts.onCancel()      可選。使用者按取消。
   * opts.validate(text)  可選。回傳一句話代表「不是我要的」，會顯示出來並繼續掃。
   * opts.formats         可選。預設 FORMATS。
   * opts.title           可選。畫面上方那行提示。
   */
  function open(opts) {
    opts = opts || {};
    var onResult = opts.onResult || function () {};
    var onError = opts.onError || function (m) { alert(m); };
    var onCancel = opts.onCancel || function () {};
    var validate = opts.validate || function () { return ''; };
    var formats = opts.formats || FORMATS;

    if (!supported()) {
      onError('這台裝置不能用相機掃碼，請直接打字輸入。');
      return;
    }

    var ui = buildOverlay(opts.title);
    var stream = null;
    var timer = null;
    var closed = false;

    function cleanup() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      // 沒停掉的話相機燈會一直亮著，而且下次開不起來。
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      ui.video.srcObject = null;
      ui.root.remove();
    }

    function fail(msg) {
      cleanup();
      onError(msg);
    }

    ui.cancel.addEventListener('click', function () {
      cleanup();
      onCancel();
    });

    ui.status.textContent = '正在開啟相機…';

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    }).then(function (s) {
      if (closed) { s.getTracks().forEach(function (t) { t.stop(); }); throw new Error('已取消'); }
      stream = s;
      ui.video.srcObject = s;
      // iOS 有時候會擋自動播放，play() 被拒絕不代表壞掉，畫面通常還是會動。
      return Promise.resolve(ui.video.play()).catch(function () {});
    }).catch(function (e) {
      if (closed) return;
      var name = e && e.name;
      if (global.console) console.error('[CCScan] 開相機失敗', e);
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw friendly('沒有相機權限。請在瀏覽器設定裡允許這個網站使用相機，或直接打字輸入。');
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
        throw friendly('找不到可以用的相機，請直接打字輸入。');
      }
      throw friendly('打不開相機，請直接打字輸入。');
    }).then(function () {
      if (closed) return null;
      ui.status.textContent = '正在載入掃碼元件…';
      return getDetector(formats);
    }).then(function (detector) {
      if (closed || !detector) return;
      ui.status.textContent = '';
      scanLoop(detector);
    }).catch(function (e) {
      if (closed) return;
      // 只有我們自己寫的訊息才給護理師看，程式內部的錯誤丟 console 就好。
      if (e && e.friendly) { fail(e.message); return; }
      if (global.console) console.error('[CCScan] 掃碼失敗', e);
      fail('掃碼功能出了問題，請直接打字輸入員工編號。');
    });

    function scanLoop(detector) {
      if (closed) return;
      detector.detect(ui.video).then(function (codes) {
        if (closed) return;
        if (codes && codes.length) {
          var text = String(codes[0].rawValue || '').trim().toUpperCase();
          if (text) {
            var bad = validate(text);
            if (!bad) {
              cleanup();
              onResult(text);
              return;
            }
            // 掃錯東西不要關掉畫面，讓他直接換一張再掃。
            ui.status.textContent = bad;
          }
        }
        timer = setTimeout(function () { scanLoop(detector); }, DETECT_INTERVAL_MS);
      }).catch(function () {
        // 單張 frame 解不開是常態（畫面還在對焦），不要當成錯誤。
        if (closed) return;
        timer = setTimeout(function () { scanLoop(detector); }, DETECT_INTERVAL_MS);
      });
    }
  }

  global.CCScan = {
    open: open,
    supported: supported,
    employeeBadge: employeeBadge,
    FORMATS: FORMATS
  };
})(window);
