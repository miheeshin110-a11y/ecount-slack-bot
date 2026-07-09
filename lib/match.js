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

function searchCustomers(query, customers) {
  return search(query, customers, "name", "code");
}

module.exports = { searchProducts, searchCustomers };
