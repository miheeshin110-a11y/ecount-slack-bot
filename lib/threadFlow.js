// ============================================================
// 텍스트(자연어) 한 덩어리를 받아서 재고조회/주문서 응답을 만드는 공통 파이프라인
// - runQuery: 단발성 메시지(최초 멘션/DM) 처리
// - runQueryWithHistory: 스레드 후속 답장 처리. 마지막 답장이 "품목코드/거래처코드 그 자체"면
//   Claude 재해석 없이 코드로 직접 확정한다 (Claude가 여러 턴을 재구성하며 생기는 오차 방지)
// ============================================================
const { getProducts } = require("./ecount");
const customersMaster = require("./customers");
const { parseIntent } = require("./claude");
const {
  usageText,
  buildCandidateBlocks,
  tooManyCandidatesText,
  MAX_CANDIDATES_FOR_DROPDOWN,
  resolveInventoryQuery,
  buildInventoryText,
  resolveOrder,
  buildOrderConfirmBlocks,
} = require("./handlers");

function findByCodeExact(list, code) {
  const c = String(code || "").trim().toLowerCase();
  if (!c) return null;
  return list.find((item) => String(item.code).toLowerCase() === c) || null;
}

// 답장 문장 전체에 코드가 "포함"되어 있는지 찾음 (예: "파라다이스 그레인버닝 (병) (V00100106)" 처럼
// 이름과 코드를 같이 말한 경우에도 코드만 추출해내기 위함). 긴 코드부터 검사해 오탐을 줄임.
function findCodeSubstring(list, text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  const sorted = [...list].sort((a, b) => String(b.code).length - String(a.code).length);
  const found = sorted.find((item) => {
    const code = String(item.code).toLowerCase();
    return code.length >= 3 && t.includes(code); // 너무 짧은 코드로 인한 오탐 방지
  });
  return found ? found.code : null;
}

// 원래 요청(firstText)을 다시 해석하되, 이미 알고 있는 코드(overrideCode)로 모호했던 부분을 직접 확정
async function resolveWithCodeOverride(firstText, overrideCode, requestedBy, products) {
  const parsed = await parseIntent(firstText);
  const prodExact = findByCodeExact(products, overrideCode);
  const custExact = findByCodeExact(customersMaster, overrideCode);

  if (!prodExact && !custExact) return null; // 코드가 아무 마스터와도 안 맞으면 처리 못함

  if (parsed.intent === "inventory") {
    if (!prodExact) return null;
    const resolved = { type: "single", product: prodExact };
    const msg = await buildInventoryText(resolved, products);
    return { text: msg };
  }

  if (parsed.intent === "order") {
    if (custExact) parsed.custQuery = custExact.code; // 정확한 코드로 교체 → 이후 exact-code 매칭됨
    if (prodExact && parsed.items?.length) {
      // 단순화: 품목이 하나인 경우가 대부분이므로 첫 품목에 적용
      parsed.items[0].prodQuery = prodExact.code;
    }
    const order = await resolveOrder(parsed, customersMaster, products);
    if (order.error) return { text: order.error };
    const confirm = await buildOrderConfirmBlocks(order, requestedBy);
    return { text: confirm.text, blocks: confirm.blocks };
  }

  return null;
}

// 반환값: { text, blocks? } - 단발성 메시지(스레드 이력 없음) 처리
async function runQuery(text, requestedBy) {
  if (!text) return { text: usageText() };

  const products = await getProducts();
  const parsed = await parseIntent(text);
  return runParsed(parsed, products, requestedBy);
}

async function runParsed(parsed, products, requestedBy) {
  if (parsed.intent === "inventory") {
    const resolved = await resolveInventoryQuery(parsed.query, products);

    if (resolved.type === "multiple") {
      if (resolved.candidates.length > MAX_CANDIDATES_FOR_DROPDOWN) {
        return { text: tooManyCandidatesText(resolved.candidates, "product") };
      }
      return {
        text: `여러 품목이 검색됐어요 (${resolved.candidates.length}건)`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:mag: 어떤 품목인지 여러 개가 걸려요. 아래에서 선택해주세요:` } },
          ...buildCandidateBlocks(resolved.candidates),
        ],
      };
    }

    const msg = await buildInventoryText(resolved, products);
    return { text: msg };
  }

  if (parsed.intent === "order") {
    const order = await resolveOrder(parsed, customersMaster, products);
    if (order.error) return { text: order.error };
    const confirm = await buildOrderConfirmBlocks(order, requestedBy);
    return { text: confirm.text, blocks: confirm.blocks };
  }

  return { text: usageText() };
}

// 스레드 안의 사람 메시지 배열을 받아서 처리 (되묻기 이후 답장 처리용)
// messages[0] = 최초 요청, messages[messages.length-1] = 가장 최근 답장
async function runQueryWithHistory(messages, requestedBy) {
  if (!messages || messages.length === 0) return { text: usageText() };

  const products = await getProducts();

  if (messages.length > 1) {
    const firstText = messages[0];
    const lastText = messages[messages.length - 1];

    // 마지막 답장 문장 안에 품목코드/거래처코드가 포함돼 있으면(이름과 같이 말해도) 그 코드를 추출
    const codeInProducts = findCodeSubstring(products, lastText);
    const codeInCustomers = findCodeSubstring(customersMaster, lastText);
    const overrideCode = codeInProducts || codeInCustomers;

    if (overrideCode) {
      const overrideResult = await resolveWithCodeOverride(firstText, overrideCode, requestedBy, products);
      if (overrideResult) return overrideResult;
    }
  }

  // 코드 단독 답장이 아니면(예: "더존" 같은 이름으로 답장), 전체 문맥을 합쳐서 다시 해석
  const combinedText = messages.join("\n");
  const parsed = await parseIntent(combinedText);
  return runParsed(parsed, products, requestedBy);
}

module.exports = { runQuery, runQueryWithHistory };
