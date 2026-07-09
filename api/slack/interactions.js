// ============================================================
// POST /api/slack/interactions
// Slack App > Interactivity & Shortcuts 의 Request URL 로 등록
// ============================================================
const { verifySlackRequest } = require("../../lib/verify");
const { saveSaleOrder } = require("../../lib/ecount");
const { fmtQty } = require("../../lib/handlers");
const { slack, getThreadUserText } = require("../../lib/threadContext");
const { runQuery } = require("../../lib/threadFlow");
const { waitUntil } = require("@vercel/functions");

async function processOrderAction(action, channel, ts) {
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

// 드롭다운에서 후보를 선택했을 때: 선택한 코드를 스레드 문맥에 이어붙여서 재해석
// (이름 대신 코드를 사용해서 괄호/띄어쓰기 차이로 인한 재매칭 실패를 방지)
async function processCandidateSelection(action, channel, message, userId) {
  const selectedCode = action.selected_option?.value;
  if (!selectedCode) return;

  const thread_ts = message?.thread_ts || message?.ts;

  try {
    // 확인 메시지엔 사람이 읽기 편한 이름을 보여줌 (드롭다운에 표시됐던 텍스트 그대로 재사용)
    const displayLabel = action.selected_option?.text?.text || selectedCode;
    await slack.chat.update({
      channel,
      ts: message.ts,
      text: `:white_check_mark: *${displayLabel}* 선택함`,
      blocks: [],
    });

    const priorText = await getThreadUserText(channel, thread_ts);
    // 재해석에는 이름이 아니라 코드를 넘겨서, Claude가 재구성하며 생기는 표기 차이를 피함
    const combinedText = [priorText, selectedCode].filter(Boolean).join("\n");
    const result = await runQuery(combinedText, userId);

    await slack.chat.postMessage({ channel, thread_ts, text: result.text, blocks: result.blocks });
  } catch (err) {
    console.error(err);
    await slack.chat.postMessage({
      channel,
      thread_ts,
      text: `:warning: 처리 중 오류가 발생했어요.\n\`${err.message}\``,
    });
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

  // 버튼/드롭다운 클릭은 반드시 3초 내 200 응답 필요 → 먼저 ack
  res.status(200).send("");

  const action = payload.actions?.[0];
  const channel = payload.channel?.id;

  if (!action) return;

  if (action.action_id === "select_candidate") {
    waitUntil(processCandidateSelection(action, channel, payload.message, payload.user?.id));
    return;
  }

  // confirm_order / cancel_order
  const ts = payload.message?.ts;
  waitUntil(processOrderAction(action, channel, ts));
};
