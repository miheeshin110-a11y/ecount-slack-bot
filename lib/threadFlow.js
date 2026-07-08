// ============================================================
// 텍스트(자연어) 한 덩어리를 받아서 재고조회/주문서 응답을 만드는 공통 파이프라인
// - 최초 멘션/DM 메시지 처리와, 드롭다운 선택 후 이어지는 처리 둘 다 여기를 거침
// ============================================================
const { getProducts } = require("./ecount");
const customersMaster = require("./customers");
const { parseIntent } = require("./claude");
const {
  usageText,
  buildCandidateBlocks,
  resolveInventoryQuery,
  buildInventoryText,
  resolveOrder,
  buildOrderConfirmBlocks,
} = require("./handlers");

// 반환값: { text, blocks? }
async function runQuery(text, requestedBy) {
  if (!text) return { text: usageText() };

  const products = await getProducts();
  const parsed = await parseIntent(text);

  if (parsed.intent === "inventory") {
    const resolved = await resolveInventoryQuery(parsed.query, products);
    if (resolved.type === "multiple") {
      return {
        text: `여러 품목이 검색됐어요 (${resolved.candidates.length}건)`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `:mag: 어떤 품목인지 여러 개가 걸려요. 아래에서 선택해주세요:` },
          },
          ...buildCandidateBlocks(resolved.candidates),
        ],
      };
    }
    const msg = await buildInventoryText(resolved, products);
    return { text: msg };
  }

  if (parsed.intent === "order") {
    const order = await resolveOrder(parsed, customersMaster, products);
    if (order.error) {
      if (order.candidates) {
        return {
          text: order.error,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `:mag: ${order.error}` } },
            ...buildCandidateBlocks(order.candidates),
          ],
        };
      }
      return { text: `:mag: ${order.error}` };
    }
    const confirm = await buildOrderConfirmBlocks(order, requestedBy);
    return { text: confirm.text, blocks: confirm.blocks };
  }

  return { text: usageText() };
}

module.exports = { runQuery };
