/*
 * 跟 Power Automate 說話的那一層。
 * 只有兩件事：拿急救車背景資料、送出表單。
 */
(function (global) {
  'use strict';

  var cfg = null;
  var rulesDoc = null;

  function getJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /** 讀 config.json 與 rules.json，只讀一次。 */
  function boot() {
    if (cfg && rulesDoc) return Promise.resolve({ config: cfg, rules: rulesDoc });
    return Promise.all([
      getJson('config.json?v=' + Date.now()),
      getJson('rules.json?v=' + Date.now())
    ]).then(function (r) {
      cfg = r[0];
      rulesDoc = r[1];
      return { config: cfg, rules: rulesDoc };
    });
  }

  /**
   * 拿急救車背景資料。
   * demo=1 時讀本機的 demo-context.json，方便還沒建流程就先看畫面。
   */
  function getCartContext(cartCode, token, demo) {
    if (demo) return getJson('demo-context.json?v=' + Date.now());
    if (!cfg.getCartContextUrl) {
      return Promise.reject(new Error('尚未設定 getCartContextUrl（階段 3 才會填）'));
    }
    var u = cfg.getCartContextUrl +
      (cfg.getCartContextUrl.indexOf('?') >= 0 ? '&' : '?') +
      'cart=' + encodeURIComponent(cartCode) +
      '&t=' + encodeURIComponent(token);
    return getJson(u);
  }

  /**
   * 查一個員工編號。
   *
   * 為什麼一次只查一個，不整份名冊送到前端：
   *   這個頁面是公開的，只要有 QR token 就打得開。
   *   如果回傳整個單位的名冊，等於 QR code 一外流，名冊就外流。
   *   改成一次查一個，配合後端記錄與限流，外洩面小很多。
   */
  function lookupEmployee(cartCode, token, empNo, demo) {
    if (demo) {
      return getJson('demo-context.json?v=' + Date.now()).then(function (ctx) {
        var hit = (ctx.demoEmployees || []).filter(function (e) { return e.empNo === empNo; })[0];
        if (!hit) return { ok: true, valid: false, reason: '查無此員工編號' };
        if (hit.unitCode !== ctx.cart.UnitCode) {
          return { ok: true, valid: false, empName: hit.empName, reason: '不屬於本單位' };
        }
        return { ok: true, valid: true, empNo: hit.empNo, empName: hit.empName };
      });
    }
    if (!cfg.getCartContextUrl) {
      return Promise.reject(new Error('尚未設定 getCartContextUrl（階段 3 才會填）'));
    }
    var u = cfg.getCartContextUrl +
      (cfg.getCartContextUrl.indexOf('?') >= 0 ? '&' : '?') +
      'cart=' + encodeURIComponent(cartCode) +
      '&t=' + encodeURIComponent(token) +
      '&emp=' + encodeURIComponent(empNo);
    return getJson(u);
  }

  /** 送出定期點班（附件九）。 */
  function submitPeriodic(payload, demo) {
    if (demo) {
      return new Promise(function (res) {
        setTimeout(function () {
          res({ ok: true, recordId: 'DEMO-' + Date.now(), demo: true });
        }, 600);
      });
    }
    if (!cfg.submitPeriodicUrl) {
      return Promise.reject(new Error('尚未設定 submitPeriodicUrl（階段 3 才會填）'));
    }
    // 為什麼用 text/plain 而不是 application/json：
    //   瀏覽器對 application/json 的跨網域 POST 會先送一個 OPTIONS 預檢請求，
    //   但 Power Automate 的 HTTP 觸發器只認一種方法，答不了 OPTIONS，整個請求就失敗。
    //   text/plain 屬於「簡單請求」，不會預檢。流程那邊用 json(string(triggerBody())) 解回物件。
    return getJson(cfg.submitPeriodicUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload)
    });
  }

  global.CCApi = {
    boot: boot,
    getCartContext: getCartContext,
    lookupEmployee: lookupEmployee,
    submitPeriodic: submitPeriodic,
    get config() { return cfg; },
    get rules() { return rulesDoc; }
  };
})(window);
