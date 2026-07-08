// ============================================================
// 검색어 → 마스터 목록 매칭 (품목/거래처 공용)
// 정확히 1개면 바로 확정, 여러 개면 후보 목록 반환해서 되묻는 데 사용
// ============================================================

// 대소문자/공백 무시하고 부분일치 검색
function search(query, list, nameKey = "name", codeKey = "code") {
  const q = (query || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return { matched: null, candidates: [] };

  // 코드 완전일치가 있으면 그걸 최우선으로 확정
  const exactCode = list.find((item) => String(item[codeKey]).toLowerCase() === q);
  if (exactCode) return { matched: exactCode, candidates: [exactCode] };

  const candidates = list.filter((item) => {
    const name = String(item[nameKey] || "").toLowerCase().replace(/\s+/g, "");
    return name.includes(q);
  });

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
