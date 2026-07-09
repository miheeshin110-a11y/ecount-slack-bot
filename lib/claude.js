// ============================================================
// Claude API: 자연어 → 의도(intent) + 검색어 추출
// - 실제 품목/거래처 코드 매핑은 Claude가 추측하지 않고, 이 결과를 바탕으로
//   handlers.js에서 마스터 목록과 직접(문자열 포함) 매칭해 후보를 뽑는다.
//   (LLM이 코드를 잘못 찍는 걸 방지하고, 후보가 여러 개면 사용자에게 되묻기 위함)
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function parseIntent(text) {
  const system = `너는 이카운트 ERP 슬랙봇의 의도 분석기다. 사용자의 한국어 메시지를 분석해 JSON만 출력한다. 마크다운 백틱, 설명 없이 순수 JSON만. 품목명/거래처명은 마스터와 매칭하지 말고, 사용자가 말한 검색어를 그대로 추출해라.

**중요: 검색어(query, prodQuery, custQuery)는 사용자가 말한 단어를 절대 줄이거나 일부만 빼지 마라.** "알파CD"라고 했으면 "알파"가 아니라 반드시 "알파CD" 그대로 추출한다. "그레인버닝"이라고 했으면 "그레인"이 아니라 "그레인버닝" 그대로. 일부만 추출하면 관련없는 다른 품목까지 검색되어 혼란을 준다. **만약 메시지 안에 "V00100078" 같은 영문+숫자로 된 코드가 있다면, 그 코드를 절대 변형하지 말고 정확히 그대로(대소문자, 숫자까지 완전히 동일하게) 검색어로 사용해라.**

의도 종류:
1. "inventory" — 재고 수량 조회. 예: "파라 재고 얼마야?", "전체 재고 현황"
2. "order" — 주문서(수주) 입력. 예: "A거래처에 파라 30개 발주 넣어줘"
3. "help" — 그 외 인사, 사용법 문의 등

출력 형식:
- 재고조회: {"intent":"inventory","query":"검색어 전체(전체 조회면 빈 문자열)"}
- 주문입력: {"intent":"order","custQuery":"거래처 검색어 전체","items":[{"prodQuery":"품목 검색어 전체","qty":수량}],"missing":["부족한 정보 필드명(custQuery, qty 등)"]}
- 기타: {"intent":"help"}

예시:
"파라다이스그레인 재고 얼마야" → {"intent":"inventory","query":"파라다이스그레인"}
"알파CD 재고 얼마야" → {"intent":"inventory","query":"알파CD"}
"GS리테일에 알파CD 30개 발주 넣어줘" → {"intent":"order","custQuery":"GS리테일","items":[{"prodQuery":"알파CD","qty":30}],"missing":[]}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
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
