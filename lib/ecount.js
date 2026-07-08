// ============================================================
// 이카운트 OpenAPI 클라이언트 (Vercel 서버리스 환경)
// - 서버리스는 인스턴스가 매번 새로 뜰 수 있어서 세션 캐시가 항상 유효하진 않음
// - 그래도 같은 인스턴스가 잠깐 재사용될 수 있어 모듈 스코프 캐시는 유지 (있으면 이득, 없어도 무해)
// ============================================================
const COM_CODE = process.env.ECOUNT_COM_CODE;
const USER_ID = process.env.ECOUNT_USER_ID;
const API_CERT_KEY = process.env.ECOUNT_API_CERT_KEY;
const IS_SANDBOX = process.env.ECOUNT_ENV === "sandbox";
const HOST_PREFIX = IS_SANDBOX ? "sboapi" : "oapi";

let cached = { zone: null, sessionId: null, loginAt: 0 };
const SESSION_TTL_MS = 20 * 60 * 1000;

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ECOUNT HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getZone() {
  if (cached.zone) return cached.zone;
  const url = `https://${HOST_PREFIX}.ecount.com/OAPI/V2/Zone`;
  const data = await post(url, { COM_CODE });
  const zone = data?.Data?.ZONE;
  if (!zone) throw new Error(`ZONE 조회 실패: ${JSON.stringify(data)}`);
  cached.zone = zone;
  return zone;
}

async function login() {
  const zone = await getZone();
  const url = `https://${HOST_PREFIX}${zone}.ecount.com/OAPI/V2/OAPILogin`;
  const data = await post(url, {
    COM_CODE,
    USER_ID,
    API_CERT_KEY,
    LAN_TYPE: "ko-KR",
    ZONE: zone,
  });
  const sessionId = data?.Data?.Datas?.SESSION_ID;
  if (!sessionId) throw new Error(`로그인 실패: ${JSON.stringify(data)}`);
  cached.sessionId = sessionId;
  cached.loginAt = Date.now();
  return sessionId;
}

async function getSession() {
  if (cached.sessionId && Date.now() - cached.loginAt < SESSION_TTL_MS) return cached.sessionId;
  return login();
}

async function callApi(path, body) {
  const zone = await getZone();
  let session = await getSession();
  const makeUrl = (s) => `https://${HOST_PREFIX}${zone}.ecount.com/OAPI/V2/${path}?SESSION_ID=${s}`;

  let data = await post(makeUrl(session), body);
  const errCode = data?.Status ?? data?.Error?.Code;
  if (String(errCode) !== "200" && /session/i.test(JSON.stringify(data))) {
    session = await login();
    data = await post(makeUrl(session), body);
  }
  return data;
}

let productCache = { list: [], at: 0 };
const MASTER_TTL = 5 * 60 * 1000;

async function getProducts() {
  if (productCache.list.length && Date.now() - productCache.at < MASTER_TTL) return productCache.list;
  const data = await callApi("InventoryBasic/GetBasicProductsList", { PROD_CD: "", PROD_DES: "" });
  const rows = data?.Data?.Result ?? data?.Data?.Datas ?? [];
  const list = rows.map((r) => ({ code: r.PROD_CD, name: r.PROD_DES, spec: r.SIZE_DES ?? "", unit: r.UNIT ?? "" }));
  if (list.length) productCache = { list, at: Date.now() };
  return list;
}

async function getInventory({ prodCd = "", baseDate } = {}) {
  const date = baseDate || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replace(/-/g, "");
  const data = await callApi("InventoryBalance/GetListInventoryBalanceStatus", { PROD_CD: prodCd, BASE_DATE: date });
  const rows = data?.Data?.Result ?? data?.Data?.Datas ?? [];
  return rows.map((r) => ({
    whCode: r.WH_CD,
    whName: r.WH_DES ?? r.WH_CD,
    prodCode: r.PROD_CD,
    prodName: r.PROD_DES,
    qty: Number(r.BAL_QTY ?? r.QTY ?? 0),
  }));
}

async function saveSaleOrder({ ioDate, custCode, custName, whCode, items, remark = "" }) {
  const date = ioDate || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replace(/-/g, "");
  const SaleOrderList = items.map((it) => ({
    BulkDatas: {
      IO_DATE: date,
      CUST: custCode || "",
      CUST_DES: custName || "",
      WH_CD: whCode || process.env.ECOUNT_DEFAULT_WH || "",
      PROD_CD: it.prodCd,
      QTY: String(it.qty),
      ...(it.price ? { PRICE: String(it.price) } : {}),
      REMARKS: remark,
    },
  }));
  const data = await callApi("SaleOrder/SaveSaleOrder", { SaleOrderList });
  const result = data?.Data;
  return {
    successCount: result?.SuccessCnt ?? 0,
    failCount: result?.FailCnt ?? 0,
    details: result?.ResultDetails ?? [],
    raw: data,
  };
}

let custCache = { list: [], at: 0 };
async function getCustomers() {
  if (custCache.list.length && Date.now() - custCache.at < MASTER_TTL) return custCache.list;
  const data = await callApi("AccountBasic/GetBasicCustList", { BUSINESS_NO: "", CUST_NAME: "" });
  const rows = data?.Data?.Result ?? data?.Data?.Datas ?? [];
  const list = rows.map((r) => ({ code: r.BUSINESS_NO ?? r.CUST, name: r.CUST_NAME ?? r.CUST_DES }));
  if (list.length) custCache = { list, at: Date.now() };
  return list;
}

module.exports = { getInventory, getProducts, getCustomers, saveSaleOrder };
