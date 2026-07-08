// ============================================================
// 재고조회 / 주문서 확인카드 생성 공통 로직
// ============================================================
const { getInventory } = require("./ecount");

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

async function buildInventoryText(parsed) {
  const rows = await getInventory({ prodCd: parsed.prodCd || "" });
  if (!rows.length) {
    return `\`${parsed.prodName || "요청하신 품목"}\` 재고 데이터를 찾지 못했어요. 품목명을 다시 확인해주세요.`;
  }

  const byProd = {};
  for (const r of rows) {
    byProd[r.prodCode] ??= { name: r.prodName, total: 0, whs: [] };
    byProd[r.prodCode].total += r.qty;
    byProd[r.prodCode].whs.push(`    └ ${r.whName}: ${fmtQty(r.qty)}`);
  }

  const prodCodes = Object.keys(byProd);
  const isAll = !parsed.prodCd;
  const lines = [];
  for (const code of prodCodes.slice(0, isAll ? 30 : 10)) {
    const p = byProd[code];
    lines.push(`*${p.name}* (\`${code}\`) — 총 *${fmtQty(p.total)}*`);
    if (!isAll) lines.push(...p.whs);
  }
  if (isAll && prodCodes.length > 30) lines.push(`_...외 ${prodCodes.length - 30}개 품목_`);

  return `:package: 재고 현황 (${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })} 기준)\n${lines.join("\n")}`;
}

// 주문 확인 검증: 문제 있으면 { error: "메시지" } 반환
async function validateOrder(parsed) {
  const missing = [];
  if (!parsed.custName && !parsed.custCode) missing.push("거래처");
  if (!parsed.items?.length || parsed.items.some((i) => !i.qty)) missing.push("품목/수량");
  const unmatched = (parsed.items || []).filter((i) => !i.prodCd);

  if (missing.length || unmatched.length) {
    const msgs = [];
    if (missing.length) msgs.push(`다음 정보가 필요해요: *${missing.join(", ")}*`);
    if (unmatched.length)
      msgs.push(`품목 매칭 실패: ${unmatched.map((i) => `\`${i.prodName}\``).join(", ")} — 정확한 품목명으로 다시 요청해주세요.`);
    return { error: `:mag: ${msgs.join("\n")}` };
  }
  return null;
}

// 주문 확인 카드의 blocks + 버튼 value(주문 데이터 자체를 압축 인코딩)
async function buildOrderConfirmBlocks(parsed, requestedBy) {
  const stockInfo = [];
  for (const it of parsed.items) {
    const inv = await getInventory({ prodCd: it.prodCd });
    const total = inv.reduce((s, r) => s + r.qty, 0);
    stockInfo.push(`• ${it.prodName} (\`${it.prodCd}\`) × *${fmtQty(it.qty)}*  _(현재고 ${fmtQty(total)})_`);
  }

  // 버튼 value에 주문 데이터를 그대로 실어서, 상태 저장소 없이도(서버리스에 적합) 다음 클릭에서 복원 가능하게 함
  const orderPayload = {
    c: parsed.custCode || "",
    cn: parsed.custName,
    items: parsed.items.map((i) => ({ p: i.prodCd, n: i.prodName, q: i.qty })),
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
          text: `:memo: *주문서(수주) 등록 확인*\n거래처: *${parsed.custName}*${parsed.custCode ? ` (\`${parsed.custCode}\`)` : ""}\n${stockInfo.join("\n")}`,
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

module.exports = { fmtQty, usageText, buildInventoryText, validateOrder, buildOrderConfirmBlocks };
