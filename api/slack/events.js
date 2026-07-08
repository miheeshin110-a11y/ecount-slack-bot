// ============================================================
// POST /api/slack/events
// Slack Event Subscriptions 의 Request URL 로 등록
// ============================================================
const { verifySlackRequest } = require("../../lib/verify");
const { getProducts, getCustomers } = require("../../lib/ecount");
const { parseIntent } = require("../../lib/claude");
const { usageText, buildInventoryText, validateOrder, buildOrderConfirmBlocks } = require("../../lib/handlers");
const { WebClient } = require("@slack/web-api");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

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

  // 1) Slack이 Request URL을 등록할 때 보내는 challenge 검증
  if (payload.type === "url_verification") {
    res.status(200).json({ challenge: payload.challenge });
    return;
  }

  // 2) Slack의 재시도 요청(3초 내 미응답 시)은 중복 처리 방지를 위해 즉시 ack만 하고 스킵
  //    (우리 로직은 아래에서 res.status(200)을 먼저 보내고 계속 처리하므로 보통 재시도까진 안 감)
  if (req.headers["x-slack-retry-num"]) {
    res.status(200).send("ok");
    return;
  }

  const event = payload.event;

  // app_mention(채널 멘션) 또는 message.im(DM) 둘 다 같은 방식으로 처리
  const isMention = event?.type === "app_mention";
  const isDirectMessage =
    event?.type === "message" && event?.channel_type === "im" && !event?.bot_id && !event?.subtype;

  if (payload.type === "event_callback" && (isMention || isDirectMessage)) {
    // 먼저 200을 응답해 Slack의 3초 타임아웃 재전송을 막고, 이어서 실제 처리를 계속함
    res.status(200).send("ok");

    // 멘션이면 <@봇ID> 태그 제거, DM이면 텍스트 그대로
    const text = event.text.replace(/<@[^>]+>/g, "").trim();
    const channel = event.channel;
    // 채널 멘션은 스레드로 답장, DM은 스레드 없이 바로 답장
    const thread_ts = isMention ? event.ts : undefined;

    try {
      if (!text) {
        await slack.chat.postMessage({ channel, thread_ts, text: usageText() });
        return;
      }

      const [products, customers] = await Promise.all([getProducts(), getCustomers()]);
      const parsed = await parseIntent(text, products, customers);

      if (parsed.intent === "inventory") {
        const msg = await buildInventoryText(parsed);
        await slack.chat.postMessage({ channel, thread_ts, text: msg });
      } else if (parsed.intent === "order") {
        const invalid = await validateOrder(parsed);
        if (invalid) {
          await slack.chat.postMessage({ channel, thread_ts, text: invalid.error });
          return;
        }
        const confirm = await buildOrderConfirmBlocks(parsed, event.user);
        await slack.chat.postMessage({ channel, thread_ts, text: confirm.text, blocks: confirm.blocks });
      } else {
        await slack.chat.postMessage({ channel, thread_ts, text: usageText() });
      }
    } catch (err) {
      console.error(err);
      await slack.chat.postMessage({
        channel,
        thread_ts,
        text: `:warning: 처리 중 오류가 발생했어요.\n\`${err.message}\``,
      });
    }
    return;
  }

  // 그 외 이벤트는 무시하되 200으로 응답
  res.status(200).send("ok");
};
