// ============================================================
// POST /api/slack/interactions
// Slack App > Interactivity & Shortcuts 의 Request URL 로 등록
// ============================================================
const { verifySlackRequest } = require("../../lib/verify");
const { saveSaleOrder } = require("../../lib/ecount");
const { fmtQty } = require("../../lib/handlers");
const { WebClient } = require("@slack/web-api");
const { waitUntil } = require("@vercel/functions");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

async function processAction(action, channel, ts) {
  try {
    if (action.action_id === "cancel_order") {
      await slack.chat.update({
        channel,
        ts,
        text: ":no_entry_sign: 주문서 등록이 취소되었어요.",
        blocks: [],
      });
      return;
    }

    if (action.action_id === "confirm_order") {
      const order = JSON.parse(action.value); // { c, cn, items:[{p,n,q}], u }

      const result = await saveSaleOrder({
        custCode: order.c,
        custName: order.cn,
        items: order.items.map((i) => ({ prodCd: i.p, qty: i.q })),
        remark: `Slack 발주 (요청자: <@${order.u}>)`,
      });

      if (result.failCount > 0) {
        const errs = result.details
          .filter((d) => d.IsSuccess === false || d.IsSuccess === "false")
          .map((d) => d?.TotalError ?? JSON.stringify(d).slice(0, 200))
          .join("\n");
        await slack.chat.update({
          channel,
          ts,
          text: `:x: 주문서 등록 일부 실패 (성공 ${result.successCount} / 실패 ${result.failCount})\n\`\`\`${errs}\`\`\``,
          blocks: [],
        });
      } else {
        await slack.chat.update({
          channel,
          ts,
          text: `:white_check_mark: 이카운트 주문서 등록 완료!\n거래처: *${order.cn}* / ${order.items
            .map((i) => `${i.n} × ${fmtQty(i.q)}`)
            .join(", ")}\n요청자: <@${order.u}>`,
          blocks: [],
        });
      }
    }
  } catch (err) {
    console.error(err);
    if (channel && ts) {
      await slack.chat.update({
        channel,
        ts,
        text: `:warning: 이카운트 전송 중 오류: \`${err.message}\``,
        blocks: [],
      });
    }
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const payload = await verifySlackRequest(req);
  if (!payload) {
    res.status(401).send("invalid signature");
    return;
  }

  // 버튼 클릭은 반드시 3초 내 200 응답 필요 → 먼저 ack
  res.status(200).send("");

  const action = payload.actions?.[0];
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;

  if (!action) return;

  // 응답 후에도 실제 이카운트 저장 처리가 끝까지 실행되도록 등록
  waitUntil(processAction(action, channel, ts));
};
