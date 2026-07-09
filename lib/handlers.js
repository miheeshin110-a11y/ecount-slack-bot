// ============================================================
// 재고조회 / 주문서 확인카드 생성 공통 로직
// - 검색어가 여러 품목/거래처에 걸리면 드롭다운 메뉴로 직접 선택 가능
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

// 드롭다운(static_select) 메뉴 블록 생성 - 재고조회에서만 사용
// value는 이름이 아니라 "코드"를 담아서, 선택 후 재해석 시 괄호/띄어쓰기 차이로 매칭 실패하는 걸 방지
function buildCandidateBlocks(candidates) {
  const options = candidates.slice(0, 100).map((c) => {
    const spec = c.spec ? ` (${c.spec})` : "";
    const label = `${c.name}${spec}`.slice(0, 75);
    return {
      text: { type: "plain_text", text: label, emoji: true },
      value: String(c.code).slice(0, 75),
    };
  });
  return [
    {
      type: "actions",
      elements: [
        {
          type: "static_select",
          placeholder: { type: "plain_text", text: "선택해주세요", emoji: true },
          action_id: "select_candidate",
          options,
        },
      ],
    },
  ];
}

// 후보가 너무 많을 때(드롭다운으로 보여주기엔 비효율) 검색어를 좁혀달라고 안내
const MAX_CANDIDATES_FOR_DROPDOWN = 12;

function tooManyCandidatesText(candidates, kind) {
  const label = kind === "customer" ? "거래처" : "품목";
  const examples = candidates
    .slice(0, 5)
    .map((c) => `• ${c.name} (\`${c.code}\`)`)
    .join("\n");
  return `:mag: ${label}이 ${candidates.length}건이나 걸려서 목록으로 보여드리기 어려워요. 검색어를 좀 더 구체적으로 말씀해주세요.\n예시로 이런 것들이 있어요:\n${examples}\n_...외 ${candidates.length - 5}건 더_`;
}

// 주문(발주) 흐름에서 후보가 여러 개일 때: 드롭다운 없이 텍스트 목록만 보여주고
// 정확한 이름이나 품목코드로 다시 답해달라고 안내 (발주는 드롭다운 대신 텍스트 응답 방식 선호)
function candidateListText(candidates, kind) {
  const label = kind === "customer" ? "거래처" : "품목";
  const lines = candidates
    .slice(0, 15)
    .map((c) => `• ${c.name} (\`${c.code}\`)`)
    .join("\n");
  const more = candidates.length > 15 ? `\n_...외 ${candidates.length - 15}건 더_` : "";
  return `:mag: 어떤 ${label}인지 여러 개가 걸려요. 정확한 이름이나 코드로 다시 말씀해주세요:\n${lines}${more}`;
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

  const prodCd = resolved.type === "single" ? resolved.product.code : "";
  const rows = await getInventory({ prodCd });
  if (!rows.length) {
    return resolved.type === "single"
      ? `*${resolved.product.name}* (\`${resolved.product.code}\`) 재고 데이터가 없어요 (0개일 수 있어요).`
      : "재고 데이터를 찾지 못했어요.";
  }

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
    lines.push(`*${displayName}* (\`${code}\`) — 총 *${fmtQty(p.total)}*`);
  }
  if (isAll && prodCodes.length > 30) lines.push(`_...외 ${prodCodes.length - 30}개 품목_`);

  return `:package: 재고 현황 (${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })} 기준)\n${lines.join("\n")}`;
}

// ------------------------------------------------------------
// 주문서 입력: 거래처/품목 검색어를 각각 확정. 문제 있으면 error(+선택가능하면 candidates) 반환
// ------------------------------------------------------------
async function resolveOrder(parsed, customers, products) {
  const messages = [];
  let selectableCandidates = null; // 후보가 하나라도 여러 개면 드롭다운으로 보여줄 대상
  let selectableKind = null;

  let custMatch = null;
  if (!parsed.custQuery) {
    messages.push("거래처를 말씀해주세요.");
  } else {
    const { matched, candidates } = searchCustomers(parsed.custQuery, customers);
    if (matched) custMatch = matched;
    else if (candidates.length > 1) {
      messages.push(candidateListText(candidates, "customer"));
      if (!selectableCandidates) {
        selectableCandidates = candidates;
        selectableKind = "customer";
      }
    } else messages.push(`거래처 \`${parsed.custQuery}\`를 찾지 못했어요. 정확한 거래처명으로 다시 말씀해주시거나, 신규 거래처라면 이카운트에 먼저 등록 후 다시 시도해주세요.`);
  }

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
      messages.push(candidateListText(candidates, "product"));
      if (!selectableCandidates) {
        selectableCandidates = candidates;
        selectableKind = "product";
      }
    } else {
      messages.push(`품목 \`${it.prodQuery}\`를 찾지 못했어요. 정확한 품목명으로 다시 말씀해주세요.`);
    }
  }

  if (!parsed.items || parsed.items.length === 0) {
    messages.push("발주할 품목과 수량을 말씀해주세요.");
  }

  if (!parsed.deliveryDate) {
    messages.push("납기일자(언제까지 필요한지)를 말씀해주세요. 예: `7월 15일까지`, `다음주 화요일까지`");
  }

  if (!parsed.remark) {
    messages.push("적요(어떤 건인지 간단한 메모)를 말씀해주세요. 예: `홈쇼핑 재방송용`, `긴급 보충`, `신규 거래처 초도물량` 등");
  }

  if (messages.length > 0) {
    return { error: messages.join("\n"), candidates: selectableCandidates, kind: selectableKind };
  }

  return {
    custCode: custMatch.code,
    custName: custMatch.name,
    items: resolvedItems,
    deliveryDate: parsed.deliveryDate,
    remark: parsed.remark,
  };
}

// 주문 확인 카드의 blocks + 버튼 value(주문 데이터 자체를 압축 인코딩)
async function buildOrderConfirmBlocks(order, requestedBy) {
  const stockInfo = [];
  for (const it of order.items) {
    const inv = await getInventory({ prodCd: it.prodCd });
    const total = inv.reduce((s, r) => s + r.qty, 0);
    stockInfo.push(`• ${it.prodName} (\`${it.prodCd}\`) × *${fmtQty(it.qty)}*  _(현재고 ${fmtQty(total)})_`);
  }

  const orderPayload = {
    c: order.custCode || "",
    cn: order.custName,
    items: order.items.map((i) => ({ p: i.prodCd, n: i.prodName, q: i.qty })),
    u: requestedBy,
    d: order.deliveryDate || "",
    r: order.remark || "",
  };
  const value = JSON.stringify(orderPayload);

  const deliveryText = order.deliveryDate
    ? `${order.deliveryDate.slice(0, 4)}.${order.deliveryDate.slice(4, 6)}.${order.deliveryDate.slice(6, 8)}`
    : "-";

  return {
    text: "주문서 등록 확인",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:memo: *주문서(수주) 등록 확인*\n거래처: *${order.custName}* (\`${order.custCode}\`)\n납기일자: *${deliveryText}* / 적요: *${order.remark}*\n${stockInfo.join("\n")}`,
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
  buildCandidateBlocks,
  candidateListText,
  tooManyCandidatesText,
  MAX_CANDIDATES_FOR_DROPDOWN,
  resolveInventoryQuery,
  buildInventoryText,
  resolveOrder,
  buildOrderConfirmBlocks,
};
