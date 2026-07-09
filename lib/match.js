// ============================================================
// 검색어 → 마스터 목록 매칭 (품목/거래처 공용)
// 정확히 1개면 바로 확정, 여러 개면 후보 목록 반환해서 되묻는 데 사용
// 별칭 사전(aliases.js)에 있는 단어는 정식 명칭으로도 같이 검색함
// ============================================================
const aliases = require("./aliases");

function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, "");
}

// 검색어에 별칭이 포함되어 있으면, 별칭을 정식 명칭으로 치환한 버전도 검색어 후보에 추가
function expandQueryTerms(q) {
  const terms = new Set([q]);
  for (const [alias, real] of Object.entries(aliases)) {
    const normAlias = normalize(alias);
    const normReal = normalize(real);
    if (normAlias && q.includes(normAlias)) {
      terms.add(q.replace(normAlias, normReal));
    }
  }
  return [...terms];
}

// 대소문자/공백 무시하고 부분일치 검색 (별칭 확장 포함)
function search(query, list, nameKey = "name", codeKey = "code") {
  const q = normalize(query);
  if (!q) return { matched: null, candidates: [] };

  // 코드 완전일치가 있으면 그걸 최우선으로 확정
  const exactCode = list.find((item) => String(item[codeKey]).toLowerCase() === q);
  if (exactCode) return { matched: exactCode, candidates: [exactCode] };

  const terms = expandQueryTerms(q);
  const seen = new Set();
  const candidates = [];
  for (const item of list) {
    const name = normalize(item[nameKey]);
    if (terms.some((t) => name.includes(t))) {
      const code = item[codeKey];
      if (!seen.has(code)) {
        seen.add(code);
        candidates.push(item);
      }
    }
  }

  if (candidates.length === 1) return { matched: candidates[0], candidates };
  return { matched: null, candidates };
}

function searchProducts(query, products) {
  return search(query, products, "name", "code");
}

// 이카운트는 거래처 "조회" API가 없어서 신규 거래처가 로컬 목록(customers.js)에
// 실시간 반영이 안 됨. 대신 거래처코드가 사업자등록번호 형식(숫자만, 10자리)이면
// 목록에 없어도 그 코드로 진행시키고, 실제 존재 여부는 이카운트 API가 최종 검증하게 함.
function looksLikeBusinessRegNo(code) {
  return /^\d{10}$/.test(String(code || "").trim());
}

function searchCustomers(query, customers) {
  const result = search(query, customers, "name", "code");
  if (result.matched) return result;

  const q = String(query || "").trim();
  if (looksLikeBusinessRegNo(q) && result.candidates.length === 0) {
    // 로컬 목록엔 없지만 사업자등록번호 형식이라 일단 통과시킴 (신규 거래처 대응)
    return { matched: { code: q, name: q }, candidates: [{ code: q, name: q }] };
  }
  return result;
}

module.exports = { searchProducts, searchCustomers };
