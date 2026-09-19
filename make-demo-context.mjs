// 產生 demo-context.json：讓靜態頁在還沒接 Flow-1 之前就能看畫面與測規則。
// 內容格式必須跟 Flow-1 GetCartContext 的回應一模一樣，否則測了也沒用。
//
// 用法：node web/make-demo-context.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const seed = join(here, '..', 'sharepoint', 'seed');
const load = (n) => JSON.parse(readFileSync(join(seed, `${n}.json`), 'utf8')).items.map((i) => JSON.parse(i.body));

const settings = {};
for (const s of load('Settings')) settings[s.Title] = s.Value;

const items = load('StandardItems')
  .filter((i) => i.IsActive)
  .sort((a, b) => a.SortOrder - b.SortOrder)
  .map((i) => ({
    name: i.Title,
    section: i.Section,
    spec: i.Spec,
    qtyText: i.QtyText,
    standardQty: i.StandardQty,
    isEachSpec: i.IsEachSpec,
    checkQty: i.CheckQty,
    checkFunction: i.CheckFunction,
    checkQuality: i.CheckQuality,
    checkExpiry: i.CheckExpiry,
    specialRule: i.SpecialRule,
  }));

const plusDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// 示範用的假資料。真的 QR token 不會進版控。
const ctx = {
  ok: true,
  demo: true,
  cart: {
    CartCode: 'CC-8A-01',
    UnitCode: '8A',
    Location: '8A 護理站旁走廊',
    TemplateCode: 'PED-LK',
    OuterSealNumber: 'S01001',
    Tray1SealNumber: 'T10101',
    Tray2SealNumber: 'T20101',
    NextTrayChangeOn: plusDays(30),
    AmbuExpiryOn: plusDays(180),
    AmbuMaskExpiryOn: plusDays(180),
    LaryngoBatteryOn: plusDays(-20),
    LaryngoUseCount: 0,
    InUse: false,
  },
  // 這兩個欄位跟 Flow-1 回傳的一致，否則示範模式算不出封簽鎖餘量。
  unit: { UnitCode: '8A', UnitName: '小兒加護病房 8A', ShiftMode: '三班制 (D/E/N)', SealStockTotal: 5, SealStockRemain: 5 },
  settings,
  items,
  recentSealNumbers: [],
  // 只有示範模式才把名冊放在前端。正式版是打 Flow-1 一次查一個人，
  // 避免掃到 QR code 的人就拿到整個單位的護理師名冊。
  demoEmployees: load('Employees')
    .filter((e) => e.IsActive)
    .map((e) => ({ empNo: e.Title, empName: e.EmployeeName, unitCode: e.UnitCode })),
};

writeFileSync(join(here, 'demo-context.json'), JSON.stringify(ctx, null, 2), 'utf8');
console.log(`demo-context.json 產生完成：${items.length} 個品項、${Object.keys(settings).length} 筆設定`);
