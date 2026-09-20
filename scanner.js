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

  // iPhone 預設只給 640×480。員工證上那種細條碼在這個解析度下線會糊在一起，
  // 怎麼對都解不出來，所以一定要指定高解析度。
  var IDEAL_WIDTH = 1920;
  var IDEAL_HEIGHT = 1080;

  // 串流開起來之後還會再往上拉到相機支援的最高，但不超過這個，免得手機跑不動。
  var MAX_WIDTH = 2560;
  var MAX_HEIGHT = 1440;

  // 幾秒之後還沒掃到，就給一句怎麼拿比較好掃的提示。
  var HINT_AFTER_MS = 6000;

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

    // 只有網址帶 ?scandebug=1 才會出現，用來回報實際的相機解析度。
    var debug = document.createElement('div');
    debug.style.cssText =
      'position:absolute;left:8px;top:calc(env(safe-area-inset-top, 0px) + 52px);' +
      'color:#0f0;font:12px/1.4 monospace;text-align:left;white-space:pre;' +
      'text-shadow:0 1px 2px #000';

    root.appendChild(video);
    root.appendChild(frame);
    root.appendChild(tip);
    root.appendChild(status);
    root.appendChild(debug);
    root.appendChild(cancel);
    document.body.appendChild(root);

    return { root: root, video: video, frame: frame, status: status, debug: debug, cancel: cancel };
  }

  /**
   * 把畫面上那個白框，換算成影像裡對應的那一塊。
   *
   * 影片是用 object-fit:cover 鋪滿的，所以左右或上下會被裁掉，
   * 不能直接拿螢幕座標當影像座標。
   *
   * 只解白框那一塊有兩個好處：畫面上其他東西不會來亂，
   * 而且送進解碼器的是原始畫素，不會被整張縮圖糊掉。
   */
  function cropToFrame(video, frameEl) {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;

    var box = frameEl.getBoundingClientRect();
    var dw = video.clientWidth || window.innerWidth;
    var dh = video.clientHeight || window.innerHeight;
    var s = Math.max(dw / vw, dh / vh);          // cover 的縮放倍率
    var offX = (dw - vw * s) / 2;
    var offY = (dh - vh * s) / 2;

    var sx = (box.left - offX) / s;
    var sy = (box.top - offY) / s;
    var sw = box.width / s;
    var sh = box.height / s;

    // 條碼常常會超出框一點點，左右各多留一些比較保險。
    var padX = sw * 0.08, padY = sh * 0.15;
    sx -= padX; sw += padX * 2;
    sy -= padY; sh += padY * 2;

    sx = Math.max(0, Math.min(sx, vw));
    sy = Math.max(0, Math.min(sy, vh));
    sw = Math.max(1, Math.min(sw, vw - sx));
    sh = Math.max(1, Math.min(sh, vh - sy));

    var c = cropCanvas || (cropCanvas = document.createElement('canvas'));
    c.width = Math.round(sw);
    c.height = Math.round(sh);
    c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  var cropCanvas = null;

  /* ---------------- 主入口 ---------------- */

  /**
   * 開好串流之後，再把解析度往上拉到相機支援的最高（設一個上限免得太吃效能）。
   *
   * 為什麼要這樣做：直式手機配橫式影像，object-fit:cover 會把左右裁掉一大半，
   * 白框對應到的原始畫素其實不多。員工證上的條碼線很細，畫素不夠就解不出來。
   * 拉高解析度是唯一能補的地方。
   *
   * 失敗沒關係，就用原本的解析度繼續掃。
   */
  function raiseResolution(stream) {
    try {
      var track = stream.getVideoTracks()[0];
      if (!track || !track.getCapabilities || !track.applyConstraints) return;
      var caps = track.getCapabilities();
      if (!caps || !caps.width || !caps.width.max) return;
      var now = track.getSettings ? (track.getSettings().width || 0) : 0;
      if (now >= MAX_WIDTH) return;
      track.applyConstraints({
        width: Math.min(caps.width.max, MAX_WIDTH),
        height: caps.height && caps.height.max
          ? Math.min(caps.height.max, MAX_HEIGHT) : undefined
      }).catch(function () {});
    } catch (e) { /* 拉不動就算了 */ }
  }

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
    var hintTimer = null;
    var closed = false;
    var tick = 0;
    var attempts = 0;
    // 網址帶 ?scandebug=1 就把相機解析度顯示在畫面上，方便回報掃不到的狀況。
    var showDebug = /[?&]scandebug=1/.test(location.search);

    function cleanup() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(hintTimer);
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
      video: {
        facingMode: { ideal: 'environment' },
        // 不要求高解析度的話 iPhone 只給 640×480，細條碼會糊成一團。
        width: { ideal: IDEAL_WIDTH },
        height: { ideal: IDEAL_HEIGHT },
        advanced: [{ focusMode: 'continuous' }]
      },
      audio: false
    }).catch(function (e) {
      // 有些舊裝置給不出這個解析度，退回最低要求再試一次，不要直接放棄。
      if (e && (e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError')) {
        return navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }, audio: false
        });
      }
      throw e;
    }).then(function (s) {
      if (closed) { s.getTracks().forEach(function (t) { t.stop(); }); throw new Error('已取消'); }
      stream = s;
      raiseResolution(s);
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
      if (showDebug) {
        var t = stream && stream.getVideoTracks()[0];
        var st = t && t.getSettings ? t.getSettings() : {};
        ui.debug.textContent =
          '相機 ' + (st.width || '?') + '×' + (st.height || '?') + '\n' +
          '影像 ' + ui.video.videoWidth + '×' + ui.video.videoHeight;
      }
      // 一開始就講怎麼拿。條碼佔的畫素越多越好解，這句話比什麼都有效。
      var FIRST_HINT = '條碼要填滿白框，離 15～20 公分。';
      ui.status.textContent = FIRST_HINT;
      hintTimer = setTimeout(function () {
        // 只在還是第一句提示時才換，免得蓋掉「這不是員工證條碼」那種訊息。
        if (!closed && ui.status.textContent === FIRST_HINT) {
          ui.status.textContent = '還是對不到？卡片放平不要斜，光線要夠亮，' +
            '先拉遠再慢慢靠近讓鏡頭對焦。';
        }
      }, HINT_AFTER_MS);
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
      tick++;
      // 大多數時候只解白框那一塊，畫素最細、雜訊最少。
      // 每四次穿插一次整張畫面，萬一條碼沒完全對進框裡也接得住。
      var source = null;
      if (tick % 4 !== 0) source = cropToFrame(ui.video, ui.frame);
      if (!source) source = ui.video;
      if (showDebug) attempts++;

      detector.detect(source).then(function (codes) {
        if (closed) return;
        if (showDebug) {
          ui.debug.textContent = ui.debug.textContent.split('\n').slice(0, 2).join('\n') +
            '\n解碼 ' + attempts + ' 次　裁切 ' +
            (source === ui.video ? '整張' : source.width + '×' + source.height);
        }
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
