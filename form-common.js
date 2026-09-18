/*
 * 三張表共用的畫面零件。
 *
 * 為什麼要抽出來：
 *   附件七、八、九都要做同樣幾件事 —— 掃員工證、查員編、畫 ˇ/X 按鈕、
 *   把判定結果變成紅字、送出。
 *   寫三次就會走鐘，以後改一個地方忘了改另外兩個。
 */
(function (global) {
  'use strict';

  var A = CCRules.ANSWER;
  var el = function (id) { return document.getElementById(id); };

  var state = {
    ctx: null,
    empSource: '手動輸入',
    identityInvalid: false,
    identityReason: '',
    sending: false
  };

  /* ---------------- ˇ / X / - 按鈕 ---------------- */

  function makeSeg(values, onChange) {
    var seg = document.createElement('span');
    seg.className = 'seg';
    seg.dataset.value = '';
    values.forEach(function (v) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = v;
      b.textContent = v;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () {
        if (seg.dataset.disabled === '1') return;
        seg.dataset.value = (seg.dataset.value === v) ? '' : v;
        Array.prototype.forEach.call(seg.children, function (c) {
          c.setAttribute('aria-pressed', String(c.dataset.v === seg.dataset.value));
        });
        if (onChange) onChange();
      });
      seg.appendChild(b);
    });
    return seg;
  }

  /** 掛一組按鈕到某個容器裡，回傳那組按鈕。 */
  function mountSeg(hostId, values, onChange) {
    var seg = makeSeg(values, onChange);
    el(hostId).appendChild(seg);
    return seg;
  }

  function segValue(seg) { return seg ? seg.dataset.value : ''; }

  function setSegDisabled(seg, off) {
    if (!seg) return;
    seg.dataset.disabled = off ? '1' : '0';
    Array.prototype.forEach.call(seg.children, function (c) { c.disabled = !!off; });
    if (off) {
      seg.dataset.value = '';
      Array.prototype.forEach.call(seg.children, function (c) {
        c.setAttribute('aria-pressed', 'false');
      });
    }
  }

  /* ---------------- 紅字 ---------------- */

  function clearErrors(ids) {
    ids.forEach(function (id) { var n = el(id); if (n) n.textContent = ''; });
  }

  function groupByTarget(findings) {
    var m = {};
    findings.forEach(function (f) {
      if (!m[f.target]) m[f.target] = [];
      m[f.target].push(f);
    });
    return m;
  }

  function putError(id, byTarget, targets) {
    var node = el(id);
    if (!node) return;
    var hits = [];
    targets.forEach(function (t) {
      (byTarget[t] || []).forEach(function (f) { hits.push(f); });
    });
    if (hits.length) {
      node.textContent = hits.map(function (f) {
        return f.code + ' ' + f.name + '：' + f.message + (f.detail ? '（' + f.detail + '）' : '');
      }).join('；');
    }
  }

  function renderFindings(hostId, res) {
    var host = el(hostId);
    if (!host) return;
    if (!res.findings.length) {
      host.innerHTML = '<div class="notice ok">目前沒有發現異常。</div>';
      return;
    }
    host.innerHTML = res.findings.map(function (f) {
      var cls = (f.severity === '高') ? 'bad' : 'warn';
      return '<div class="notice ' + cls + '"><span class="pill ' + cls + '">' + f.severity + '</span> ' +
        f.code + ' ' + f.name + '　' + (f.label || f.target ? '<b>' + (f.label || f.target) + '</b>　' : '') +
        f.message + (f.detail ? '（' + f.detail + '）' : '') + '</div>';
    }).join('');
  }

  function renderFoot(hostId, res) {
    var s = el(hostId);
    if (!s) return;
    if (!res.hasAbnormal) {
      s.innerHTML = '<span class="pill ok">無異常</span> 送出後等主管確認。';
    } else if (res.requiresApproval) {
      s.innerHTML = '<span class="pill bad">高度異常 ' + res.findings.length + ' 項</span> 送出後會立刻通知主管。';
    } else {
      s.innerHTML = '<span class="pill warn">中度異常 ' + res.findings.length + ' 項</span> 送出後等主管確認。';
    }
  }

  /* ---------------- 員工編號 ---------------- */

  function wireEmployee(empNoId, empNameId, cartCode, token, demo, onChange) {
    var timer = null;
    el(empNoId).addEventListener('input', function () {
      clearTimeout(timer);
      var v = el(empNoId).value.trim().toUpperCase();
      el(empNameId).value = '';
      state.identityInvalid = false;
      state.identityReason = '';
      if (!v) { onChange(); return; }
      timer = setTimeout(function () {
        CCApi.lookupEmployee(cartCode, token, v, demo).then(function (r) {
          if (r && r.valid) {
            el(empNameId).value = r.empName || '';
          } else {
            state.identityInvalid = true;
            state.identityReason = (r && r.reason) || '查無此員工編號';
            el(empNameId).value = (r && r.empName) || '';
          }
          onChange();
        }).catch(function () {
          // 查不到就先不擋，後端會再驗一次。
          onChange();
        });
      }, 400);
    });
  }

  /* ---------------- 掃員工證條碼 ---------------- */

  function wireScan(btnId, empNoId, onChange) {
    var btn = el(btnId);
    if (!btn) return;
    if (!('BarcodeDetector' in window)) {
      btn.textContent = '不支援';
      btn.disabled = true;
      btn.title = '這台裝置的瀏覽器不支援掃碼，請直接打字。';
      return;
    }
    btn.addEventListener('click', function () {
      var video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:100;background:#000';
      var close = document.createElement('button');
      close.type = 'button';
      close.textContent = '取消';
      close.className = 'primary';
      close.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:101';
      document.body.appendChild(video);
      document.body.appendChild(close);

      var stream = null, stop = false;
      function cleanup() {
        stop = true;
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        video.remove();
        close.remove();
      }
      close.addEventListener('click', cleanup);

      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(function (s) { stream = s; video.srcObject = s; return video.play(); })
        .then(function () {
          var det = new window.BarcodeDetector();
          (function loop() {
            if (stop) return;
            det.detect(video).then(function (codes) {
              if (codes && codes.length) {
                el(empNoId).value = String(codes[0].rawValue).trim().toUpperCase();
                state.empSource = '掃描';
                cleanup();
                el(empNoId).dispatchEvent(new Event('input'));
                return;
              }
              requestAnimationFrame(loop);
            }).catch(function () { requestAnimationFrame(loop); });
          })();
        })
        .catch(function () {
          cleanup();
          alert('打不開相機，請直接打字輸入員工編號。');
        });
    });
  }

  /* ---------------- 班別下拉 ---------------- */

  function fillShiftOptions(selectId, ctx) {
    var sel = el(selectId);
    if (!sel) return;
    var mode = (ctx.unit && ctx.unit.ShiftMode) || '';
    var opts = (mode.indexOf('常日班') >= 0) ? ['D 白班'] : ['D 白班', 'E 小夜', 'N 大夜'];
    sel.innerHTML = opts.map(function (o) { return '<option value="' + o + '">' + o + '</option>'; }).join('');
  }

  /* ---------------- 啟動 ---------------- */

  function boot(opts) {
    var msg = el('msg');
    function fail(text) {
      var sub = el('sub');
      if (sub) sub.textContent = '無法開啟';
      if (msg) msg.innerHTML = '<div class="notice bad">' + text + '</div>';
    }

    if (!opts.demo && (!opts.cartCode || !opts.token)) {
      fail('網址不完整。請重新掃描急救車上的 QR code。');
      return;
    }

    var rulesDoc = null;
    CCApi.boot()
      .then(function (b) {
        rulesDoc = b.rules;
        return CCApi.getCartContext(opts.cartCode, opts.token, opts.demo);
      })
      .then(function (c) {
        if (!c || c.ok === false) throw new Error((c && c.error) || 'QR code 無效');
        state.ctx = c;
        var sub = el('sub');
        if (sub) sub.textContent = c.cart.CartCode + '｜' + (c.unit ? c.unit.UnitName : c.cart.UnitCode);
        if (opts.demo && msg) {
          msg.innerHTML = '<div class="notice warn">示範模式：資料是假的，送出不會存進 SharePoint。</div>';
        }
        opts.onReady(c, rulesDoc);
      })
      .catch(function (e) {
        fail('打不開這張表：' + e.message + '。請找單位主管處理。');
      });
  }

  /* ---------------- 送出 ---------------- */

  function submit(o) {
    if (state.sending) return;
    var warn = o.result.hasAbnormal
      ? '這張表有 ' + o.result.findings.length + ' 項異常，送出後會通知主管。確定送出嗎？'
      : '確定送出嗎？送出後不能修改。';
    if (!confirm(warn)) return;

    state.sending = true;
    var btn = el(o.btnId);
    btn.disabled = true;
    btn.textContent = '送出中…';

    // 後端會用同一份 rules.json 重算，這份只當對照，不當依據。
    var payload = o.form;
    payload.clientFindings = o.result.findings;
    payload.clientRulesVersion = o.rulesDoc.version;
    payload.token = o.token;

    CCApi.submit(o.endpoint, payload, o.demo).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || '送出失敗');
      document.body.innerHTML =
        '<div class="wrap"><div class="notice ok" style="margin-top:40px">' +
        '<h2>送出成功</h2><p>單號：' + (r.recordId || '(無)') + '</p>' +
        (o.result.hasAbnormal ? '<p>已通知主管。</p>' : '<p>沒有異常，等主管確認即可。</p>') +
        (r.demo ? '<p><b>示範模式，資料沒有真的存起來。</b></p>' : '') +
        '</div></div>';
    }).catch(function (e) {
      state.sending = false;
      btn.disabled = false;
      btn.textContent = '送出';
      alert('送出失敗：' + e.message + '。請再試一次，或改用紙本並告知主管。');
    });
  }

  global.CCForm = {
    el: el,
    makeSeg: makeSeg,
    mountSeg: mountSeg,
    segValue: segValue,
    setSegDisabled: setSegDisabled,
    clearErrors: clearErrors,
    groupByTarget: groupByTarget,
    putError: putError,
    renderFindings: renderFindings,
    renderFoot: renderFoot,
    wireEmployee: wireEmployee,
    wireScan: wireScan,
    fillShiftOptions: fillShiftOptions,
    boot: boot,
    submit: submit,
    empSource: function () { return state.empSource; },
    identityInvalid: function () { return state.identityInvalid; },
    identityReason: function () { return state.identityReason; }
  };
})(window);
