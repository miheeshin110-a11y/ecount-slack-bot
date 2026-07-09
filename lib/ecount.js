// ============================================================
// 이카운트 OpenAPI 클라이언트 (Vercel 서버리스 환경)
// - 서버리스는 인스턴스가 매번 새로 뜰 수 있어서 세션 캐시가 항상 유효하진 않음
// - 그래도 같은 인스턴스가 잠깐 재사용될 수 있어 모듈 스코프 캐시는 유지 (있으면 이득, 없어도 무해)
// ============================================================
// ============================================================
// 이카운트 OpenAPI 클라이언트 (Vercel 서버리스 환경)
// - 서버리스는 인스턴스가 매번 새로 뜰 수 있어서 세션 캐시가 항상 유효하진 않음
// - 그래도 같은 인스턴스가 잠깐 재사용될 수 있어 모듈 스코프 캐시는 유지 (있으면 이득, 없어도 무해)
// - 이카운트는 IP 화이트리스트를 쓰는데 Vercel은 아웃바운드 IP가 매번 바뀌므로,
//   ECOUNT_PROXY_URL(고정 IP 프록시)이 설정되어 있으면 이카운트 호출만 그 프록시를 경유시킴
// ============================================================
const { ProxyAgent, fetch: undiciFetch } = require("undici");

const COM_CODE = (process.env.ECOUNT_COM_CODE || "").trim();
const USER_ID = (process.env.ECOUNT_USER_ID || "").trim();
const API_CERT_KEY = (process.env.ECOUNT_API_CERT_KEY || "").trim();
const IS_SANDBOX = process.env.ECOUNT_ENV === "sandbox";
const HOST_PREFIX = IS_SANDBOX ? "sboapi" : "oapi";

// 고정 IP 프록시 URL. 예: http://user:pass@proxy-host:port (QuotaGuard Static 등에서 발급)
const PROXY_URL = (process.env.ECOUNT_PROXY_URL || "").trim();
const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;

// [임시 진단용] 실제 값은 노출하지 않고 길이/일부 문자만 로그로 확인
console.log("[ECOUNT DEBUG]", {
  COM_CODE_len: COM_CODE.length,
  COM_CODE_preview: COM_CODE.slice(0, 2) + "***",
  USER_ID_len: USER_ID.length,
  USER_ID_preview: USER_ID.slice(0, 2) + "***",
  API_CERT_KEY_len: API_CERT_KEY.length,
  API_CERT_KEY_preview: API_CERT_KEY.slice(0, 3) + "***" + API_CERT_KEY.slice(-2),
  ECOUNT_ENV: process.env.ECOUNT_ENV,
  USING_PROXY: !!proxyAgent,
});

let cached = { zone: null, sessionId: null, loginAt: 0 };
const SESSION_TTL_MS = 20 * 60 * 1000;

async function post(url, body) {
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (proxyAgent) opts.dispatcher = proxyAgent;

  const res = await undiciFetch(url, opts);
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
  console.log("[ECOUNT DEBUG] login 시도, zone:", zone, "HOST_PREFIX:", HOST_PREFIX);
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
  if (productCache.list.length && Date.now() - productCache.at < MASTER_TTL) {
    console.log("[ECOUNT DEBUG] getProducts: 캐시된 목록 사용, 건수:", productCache.list.length);
    return productCache.list;
  }
  const data = await callApi("InventoryBasic/GetBasicProductsList", { PROD_CD: "", PROD_DES: "" });
  const rows = data?.Data?.Result ?? data?.Data?.Datas ?? [];
  // 수량관리제외(BAL_FLAG='0') 품목은 애초에 재고수량 자체가 관리 안 되는 항목이라 검색 대상에서 제외
  const filteredRows = rows.filter((r) => r.BAL_FLAG !== "0");
  console.log(
    "[ECOUNT DEBUG] getProducts: 새로 조회함, HOST_PREFIX:",
    HOST_PREFIX,
    "전체:",
    rows.length,
    "수량관리대상만:",
    filteredRows.length
  );
  const list = filteredRows.map((r) => ({
    code: r.PROD_CD,
    name: r.PROD_DES,
    spec: r.SIZE_DES ?? "",
    unit: r.UNIT ?? "",
  }));
  if (list.length) productCache = { list, at: Date.now() };
  return list;
}

async function getInventory({ prodCd = "", baseDate } = {}) {
  const date = baseDate || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replace(/-/g, "");
  const data = await callApi("InventoryBalance/GetListInventoryBalanceStatusByLocation", {
    PROD_CD: prodCd,
    BASE_DATE: date,
  });
  const rows = data?.Data?.Result ?? data?.Data?.Datas ?? [];
  return rows.map((r) => ({
    whCode: r.WH_CD,
    whName: r.WH_DES ?? r.WH_CD,
    prodCode: r.PROD_CD,
    prodName: r.PROD_DES,
    qty: Number(r.BAL_QTY ?? 0),
  }));
}

async function saveSaleOrder({ ioDate, custCode, custName, whCode, empCode, deliveryDate, remark = "", items }) {
  const date = ioDate || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replace(/-/g, "");
  // 같은 전표로 묶을 항목들에 동일한 순번(UPLOAD_SER_NO)을 부여 (이카운트 필수 항목)
  const SaleOrderList = items.map((it, idx) => ({
    BulkDatas: {
      UPLOAD_SER_NO: 1, // 이번 주문서의 모든 품목을 한 장의 전표로 묶음
      IO_DATE: date,
      CUST: custCode || "",
      CUST_DES: custName || "",
      EMP_CD: empCode || process.env.ECOUNT_DEFAULT_EMP || "",
      WH_CD: whCode || process.env.ECOUNT_DEFAULT_WH || "",
      TIME_DATE: deliveryDate || "", // 납기일자 (YYYYMMDD)
      PROD_CD: it.prodCd,
      QTY: String(it.qty),
      ...(it.price ? { PRICE: String(it.price) } : {}),
      REMARKS: remark, // 적요
    },
  }));
  const data = await callApi("SaleOrder/SaveSaleOrder", { SaleOrderList });
  console.log("[ECOUNT DEBUG] SaveSaleOrder 응답 전체:", JSON.stringify(data));
  const result = data?.Data;

  // 최상위 Status가 200이 아니면(Data 자체가 null인 인증/권한 오류 등) 확실한 실패로 처리
  const topLevelFailed = data?.Status && String(data.Status) !== "200";
  const topLevelErrorMsg = topLevelFailed
    ? data?.Errors?.[0]?.Message || data?.Error?.Message || "알 수 없는 오류"
    : null;

  return {
    successCount: result?.SuccessCnt ?? 0,
    failCount: result?.FailCnt ?? (topLevelFailed ? 1 : 0),
    details: result?.ResultDetails ?? (topLevelErrorMsg ? [{ TotalError: topLevelErrorMsg }] : []),
    raw: data,
  };
}

module.exports = { getInventory, getProducts, saveSaleOrder };
