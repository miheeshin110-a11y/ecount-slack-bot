// ============================================================
// Claude API: 자연어 → 의도(intent) + 파라미터 파싱
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function parseIntent(text, products, customers) {
  const prodList = products.slice(0, 300).map((p) => `${p.code}\t${p.name}`).join("\n");
  const custList = customers.slice(0, 300).map((c) => `${c.code}\t${c.name}`).join("\n");

  const system = `너는 이카운트 ERP 슬랙봇의 의도 분석기다. 사용자의 한국어 메시지를 분석해 JSON만 출력한다. 마크다운 백틱, 설명 없이 순수 JSON만.

의도 종류:
1. "inventory" — 재고 수량 조회. 예: "파라 재고 얼마야?", "알파 재고 알려줘", "전체 재고 현황"
2. "order" — 주문서(수주) 입력. 예: "A거래처에 파라 30개 발주 넣어줘"
3. "help" — 그 외 인사, 사용법 문의 등

출력 형식:
- 재고조회: {"intent":"inventory","prodCd":"품목코드 또는 빈문자열(전체)","prodName":"매칭된 품목명"}
- 주문입력: {"intent":"order","custCode":"거래처코드 또는 빈문자열","custName":"거래처명","items":[{"prodCd":"품목코드","prodName":"품목명","qty":수량}],"missing":["부족한 정보 필드명"]}
  - 거래처나 수량이 없으면 missing 배열에 "custName" 또는 "qty" 등으로 표시
- 기타: {"intent":"help"}

품목명은 아래 마스터에서 가장 유사한 것을 골라 코드를 매핑해라. 애매하면 가장 가능성 높은 것 하나를 고르되, 전혀 매칭이 안 되면 prodCd를 빈문자열로 두고 prodName에 사용자가 말한 이름을 그대로 넣어라.

[품목 마스터: 코드\\t품목명]
${prodList}

[거래처 마스터: 코드\\t거래처명]
${custList}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system,
    messages: [{ role: "user", content: text }],
  });

  const raw = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .replace(/```json|```/g, "")
    .trim();

  try {
    return JSON.parse(raw);
  } catch {
    return { intent: "help" };
  }
}

module.exports = { parseIntent };
