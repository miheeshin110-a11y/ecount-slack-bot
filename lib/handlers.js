// ============================================================
// 재고조회 / 주문서 확인카드 생성 공통 로직
// - 검색어가 여러 품목/거래처에 걸리면 후보 목록을 보여주고 되물음
// - 재고 조회 결과에 바코드까지 표시 (바코드는 품목 마스터에서 가져옴, 재고API 응답 필드명 이슈와 무관)
// ============================================================
const { getInventory } = require("./ecount");
const { searchProducts, searchCustomers } = require("./match");

function fmtQty(n) {
  return Number(n).toLocaleString("ko-KR");
}

function usageText() {
  return [
    "안녕하세요! 이카운트 재고봇입니다. 이렇게 불러주세요 :point_down:",
    "• 재고 조회: `@재고봇 파라 재고 얼마야?`",
    "• 전체 재고: `@재고봇 전체 재고 현황 보여줘`",
    "• 주문서 입력: `@재고봇 OO거래처에 파라 30개 발주 넣어줘`",
  ].join("\n");
}

// 후보 여러 개일 때 사용자에게 보여줄 목록 텍스트 (품목용: 규격/바코드 포함)
function formatProductCandidates(candidates) {
  const lines = candidates
    .slice(0, 15)
    .map((p, i) => {
      const spec = p.spec ? ` / 규격: ${p.spec}` : "";
      const bar = p.barcode ? ` / 바코드: ${p.barcode}` : "";
      return `${i + 1}. *${p.name}* (\`${p.code}\`)${spec}${bar}`;
    })
    .join("\n");
  const more = candidates.length > 15 ? `\n_...외 ${candidates.length - 15}건 더 있음, 검색어를 좁혀주세요_` : "";
  return `:mag: 어떤 품목을 찾으시는지 여러 개가 걸려요. 품목코드나 정확한 이름으로 다시 말씀해주세요:\n${lines}${more}`;
}

function formatCustomerCandidates(candidates) {
  const lines = candidates
    .slice(0, 15)
    .map((c, i) => `${i + 1}. *${c.name}* (\`${c.code}\`)`)
    .join("\n");
  const more = candidates.length > 15 ? `\n_...외 ${candidates.length - 15}건 더 있음, 검색어를 좁혀주세요_` : "";
  return `:mag: 어떤 거래처인지 여러 개가 걸려요. 거래처코드나 정확한 이름으로 다시 말씀해주세요:\n${lines}${more}`;
}

// ------------------------------------------------------------
// 재고 조회: query로 품목 후보를 찾고, 확정/후보목록/없음 셋 중 하나를 반환
// ------------------------------------------------------------
async function resolveInventoryQuery(query, products) {
  if (!query) return { type: "all" }; // 빈 검색어 = 전체 조회

  const { matched, candidates } = searchProducts(query, products);
  if (matched) return { type: "single", product: matched };
  if (candidates.length > 1) return { type: "multiple", candidates };
  return { type: "none" };
}

async function buildInventoryText(resolved, products) {
  if (resolved.type === "none") {
    return `해당 품목을 찾지 못했어요. 품목명을 다시 확인해주세요.`;
  }
  if (resolved.type === "multiple") {
    return formatProductCandidates(resolved.candidates);
  }

  const prodCd = resolved.type === "single" ? resolved.product.code : "";
  const rows = await getInventory({ prodCd });
  if (!rows.length) {
    return resolved.type === "single"
      ? `*${resolved.product.name}* (\`${resolved.product.code}\`) 재고 데이터가 없어요 (0개일 수 있어요).`
      : "재고 데이터를 찾지 못했어요.";
  }

  // 바코드/규격은 재고API가 아니라 품목마스터에서 보강
  const productByCode = Object.fromEntries(products.map((p) => [p.code, p]));

  const byProd = {};
  for (const r of rows) {
    byProd[r.prodCode] ??= { total: 0 };
    byProd[r.prodCode].total += r.qty;
  }

  const prodCodes = Object.keys(byProd);
  const isAll = resolved.type === "all";
  const lines = [];
  for (const code of prodCodes.slice(0, isAll ? 30 : 10)) {
    const p = byProd[code];
    const master = productByCode[code];
    const displayName = master?.name || code;
    const bar = master?.barcode ? ` / 바코드: ${master.barcode}` : "";
    lines.push(`*${displayName}* (\`${code}\`)${bar} — 총 *${fmtQty(p.total)}*`);
  }
  if (isAll && prodCodes.length > 30) lines.push(`_...외 ${prodCodes.length - 30}개 품목_`);

  return `:package: 재고 현황 (${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })} 기준)\n${lines.join("\n")}`;
}

// ------------------------------------------------------------
// 주문서 입력: 거래처/품목 검색어를 각각 확정 짓고, 문제 있으면 안내 메시지 반환
// ------------------------------------------------------------
async function resolveOrder(parsed, customers, products) {
  const messages = [];

  // 거래처 확정
  let custMatch = null;
  if (!parsed.custQuery) {
    messages.push("거래처를 말씀해주세요.");
  } else {
    const { matched, candidates } = searchCustomers(parsed.custQuery, customers);
    if (matched) custMatch = matched;
    else if (candidates.length > 1) messages.push(formatCustomerCandidates(candidates));
    else messages.push(`거래처 \`${parsed.custQuery}\`를 찾지 못했어요. 정확한 거래처명으로 다시 말씀해주세요.`);
  }

  // 품목들 확정
  const resolvedItems = [];
  for (const it of parsed.items || []) {
    if (!it.qty) {
      messages.push(`*${it.prodQuery}*의 수량을 말씀해주세요.`);
      continue;
    }
    const { matched, candidates } = searchProducts(it.prodQuery, products);
    if (matched) {
      resolvedItems.push({ prodCd: matched.code, prodName: matched.name, qty: it.qty });
    } else if (candidates.length > 1) {
      messages.push(formatProductCandidates(candidates));
    } else {
      messages.push(`품목 \`${it.prodQuery}\`를 찾지 못했어요. 정확한 품목명으로 다시 말씀해주세요.`);
    }
  }

  if (!parsed.items || parsed.items.length === 0) {
    messages.push("발주할 품목과 수량을 말씀해주세요.");
  }

  if (messages.length > 0) {
    return { error: `:mag: ${messages.join("\n")}` };
  }

  return { custCode: custMatch.code, custName: custMatch.name, items: resolvedItems };
}

// 주문 확인 카드의 blocks + 버튼 value(주문 데이터 자체를 압축 인코딩)
async function buildOrderConfirmBlocks(order, requestedBy) {
  const stockInfo = [];
  for (const it of order.items) {
    const inv = await getInventory({ prodCd: it.prodCd });
    const total = inv.reduce((s, r) => s + r.qty, 0);
    stockInfo.push(`• ${it.prodName} (\`${it.prodCd}\`) × *${fmtQty(it.qty)}*  _(현재고 ${fmtQty(total)})_`);
  }

  // 버튼 value에 주문 데이터를 그대로 실어서, 상태 저장소 없이도(서버리스에 적합) 다음 클릭에서 복원 가능하게 함
  const orderPayload = {
    c: order.custCode || "",
    cn: order.custName,
    items: order.items.map((i) => ({ p: i.prodCd, n: i.prodName, q: i.qty })),
    u: requestedBy,
  };
  const value = JSON.stringify(orderPayload);

  return {
    text: "주문서 등록 확인",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:memo: *주문서(수주) 등록 확인*\n거래처: *${order.custName}* (\`${order.custCode}\`)\n${stockInfo.join("\n")}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: ":white_check_mark: 주문서 등록", emoji: true },
            action_id: "confirm_order",
            value,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "취소" },
            action_id: "cancel_order",
            value: "cancel",
          },
        ],
      },
    ],
  };
}

module.exports = {
  fmtQty,
  usageText,
  resolveInventoryQuery,
  buildInventoryText,
  resolveOrder,
  buildOrderConfirmBlocks,
};
