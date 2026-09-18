/*
 * 異常判定引擎（前端）。
 *
 * 規則的「代碼、名稱、嚴重度、要不要送核准、門檻值」全部來自 rules.json，
 * 這支檔案只負責「怎麼算」。Flow-2 在後端用 Power Automate 運算式做同一件事，
 * 讀的也是同一份 rules.json。兩邊一定要一起改。
 *
 * 為什麼不把判定邏輯也塞進 JSON：
 *   Power Automate 沒辦法執行 JavaScript，所以「規則的形狀」必須是資料，
 *   但「走訪 38 個品項」這種迴圈只能兩邊各寫一次。
 *   我們把可能出錯的部分（門檻、嚴重度、代碼）資料化，迴圈本身保持最笨最短。
 */
(function (global) {
  'use strict';

  var A = { ok: 'ˇ', bad: 'X', na: '-' };

  function toDate(v) {
    if (!v) return null;
    var d = new Date(String(v).slice(0, 10) + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }

  function today() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function addDays(d, n) {
    var r = new Date(d.getTime());
    r.setDate(r.getDate() + n);
    return r;
  }

  function num(v, dflt) {
    var n = parseInt(v, 10);
    return isNaN(n) ? dflt : n;
  }

  /**
   * 判定一張定期點班表（附件九）。
   *
   * @param {object} form    使用者填的內容（表頭欄位 + lines 陣列）
   * @param {object} ctx     Flow-1 給的背景資料：cart（急救車主檔）、settings、employee
   * @param {object} rulesDoc rules.json 的內容
   * @returns {{findings: Array, hasAbnormal: boolean, maxSeverity: string, requiresApproval: boolean}}
   */
  function evaluatePeriodic(form, ctx, rulesDoc) {
    var rules = {};
    rulesDoc.rules.forEach(function (r) { rules[r.code] = r; });

    var settings = (ctx && ctx.settings) || {};
    var cart = (ctx && ctx.cart) || {};
    var findings = [];

    function add(code, target, extra) {
      var r = rules[code];
      if (!r) return;
      findings.push({
        code: r.code,
        name: r.name,
        severity: r.severity,
        dimension: r.dimension,
        message: r.message,
        requiresApproval: !!r.requiresApproval,
        target: target || '',
        detail: extra || ''
      });
    }

    // ---- 表頭：封簽鎖 ----
    // R6：四個外觀 / 藥物欄位任一答 X
    ['Tray1SealIntact', 'Tray2SealIntact', 'Tray1DrugOk', 'Tray2DrugOk'].forEach(function (f) {
      if (form[f] === A.bad) add('R6', f);
    });

    // R7：號碼與主檔不符。若該車目前有未結案的取用登錄，這條不算異常。
    if (!form.openSealLogExists) {
      [['OuterSealNumber', 'OuterSealNumber'],
       ['Tray1SealNumber', 'Tray1SealNumber'],
       ['Tray2SealNumber', 'Tray2SealNumber']].forEach(function (p) {
        var typed = (form[p[0]] || '').trim();
        var master = (cart[p[1]] || '').trim();
        if (typed && master && typed !== master) {
          add('R7', p[0], '填 ' + typed + '，主檔 ' + master);
        }
      });
    }

    // ---- 表頭：車尾固定欄位 ----
    // R11：喉頭鏡柄使用次數達上限
    var maxUse = num(settings.LaryngoscopeMaxUse, 15);
    if (num(form.LaryngoUseCount, 0) >= maxUse) {
      add('R11', 'LaryngoUseCount', '已 ' + form.LaryngoUseCount + ' 次，上限 ' + maxUse);
    }

    // R12：送消 Ambu / Ambu Mask 過期
    var t = today();
    ['AmbuExpiryOn', 'AmbuMaskExpiryOn'].forEach(function (f) {
      var d = toDate(form[f]);
      if (d && d < t) add('R12', f, form[f]);
    });

    // R14：僅第一層但沒填原因代號
    if (form.Scope === '僅第一層' && !form.ReasonCode) {
      add('R14', 'ReasonCode');
    }

    // ---- 品項明細 ----
    // 僅第一層時不展開品項，也就不會有明細可判。
    var lines = (form.Scope === '僅第一層') ? [] : (form.lines || []);

    // R5 的參考日：優先用主檔的下次換藥盤日，沒有就今天 + N 天。
    var ref = toDate(cart.NextTrayChangeOn);
    if (!ref) ref = addDays(t, num(settings.ExpiringSoonFallbackDays, 30));

    var dimToRule = { '數量': 'R1', '功能': 'R2', '品質': 'R3', '有效期限': 'R4' };

    lines.forEach(function (ln) {
      Object.keys(dimToRule).forEach(function (dim) {
        if (ln[dim] === A.bad) add(dimToRule[dim], ln.name, dim + ' 不合格');
      });

      var exp = toDate(ln.expiryOn);
      if (exp) {
        if (exp < t) add('R4', ln.name, '效期 ' + ln.expiryOn + ' 已過');
        else if (exp < ref) add('R5', ln.name, '效期 ' + ln.expiryOn + '，早於 ' + fmt(ref));
      }
    });

    // ---- 身分 ----
    // R10 由後端最終認定；前端只在已經確定查不到時先標紅字。
    if (form.identityInvalid) add('R10', 'EmpNo', form.identityReason || '');

    // ---- 彙總 ----
    var order = rulesDoc.severityOrder || ['無', '中', '高'];
    var maxSeverity = '無';
    var requiresApproval = false;
    findings.forEach(function (f) {
      if (order.indexOf(f.severity) > order.indexOf(maxSeverity)) maxSeverity = f.severity;
      if (f.requiresApproval) requiresApproval = true;
    });

    return {
      findings: findings,
      hasAbnormal: findings.length > 0,
      maxSeverity: maxSeverity,
      requiresApproval: requiresApproval
    };
  }

  function fmt(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  global.CCRules = {
    ANSWER: A,
    evaluatePeriodic: evaluatePeriodic,
    todayIso: function () { return fmt(today()); }
  };
})(window);
