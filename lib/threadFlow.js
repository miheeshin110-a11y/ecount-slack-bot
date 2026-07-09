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
  buildProductCandidateBlocksWithQty,
  tooManyCandidatesText,
  MAX_CANDIDATES_FOR_DROPDOWN,
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
      if (resolved.candidates.length > MAX_CANDIDATES_FOR_DROPDOWN) {
        return { text: tooManyCandidatesText(resolved.candidates, "product") };
      }
      // 선택 전에 재고수량을 알 수 있게 드롭다운 라벨에 수량을 미리 조회해서 표시
      const blocks = await buildProductCandidateBlocksWithQty(resolved.candidates);
      return {
        text: `여러 품목이 검색됐어요 (${resolved.candidates.length}건)`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:mag: 어떤 품목인지 여러 개가 걸려요. 재고수량과 함께 아래에서 선택해주세요:` } },
          ...blocks,
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
        if (order.candidates.length > MAX_CANDIDATES_FOR_DROPDOWN) {
          return { text: tooManyCandidatesText(order.candidates, order.kind) };
        }
        // 품목 후보면 재고수량도 같이 보여주고, 거래처 후보면 이름만 보여줌
        const blocks =
          order.kind === "product"
            ? await buildProductCandidateBlocksWithQty(order.candidates)
            : buildCandidateBlocks(order.candidates);
        return {
          text: order.error,
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `:mag: ${order.error}` } }, ...blocks],
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
