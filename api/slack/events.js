// ============================================================
// POST /api/slack/events
// Slack Event Subscriptions 의 Request URL 로 등록
// ============================================================
const { verifySlackRequest } = require("../../lib/verify");
const { getProducts } = require("../../lib/ecount");
const customers = require("../../lib/customers");
const { parseIntent } = require("../../lib/claude");
const { usageText, buildInventoryText, validateOrder, buildOrderConfirmBlocks } = require("../../lib/handlers");
const { WebClient } = require("@slack/web-api");
const { waitUntil } = require("@vercel/functions");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// 실제 처리 로직 (재고조회/주문서/사용법 안내) - 응답을 이미 보낸 뒤 백그라운드로 실행됨
async function processEvent(event, isMention) {
  const text = event.text.replace(/<@[^>]+>/g, "").trim();
  const channel = event.channel;
  const thread_ts = isMention ? event.ts : undefined;

  try {
    if (!text) {
      await slack.chat.postMessage({ channel, thread_ts, text: usageText() });
      return;
    }

    // 거래처 목록은 이카운트에 조회 API가 없어서 lib/customers.js 로컬 파일에서 가져옴
    const products = await getProducts();
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
    // 먼저 200을 응답해 Slack의 3초 타임아웃 재전송을 막음
    res.status(200).send("ok");
    // Vercel Fluid compute 환경에서는 응답 후 코드가 실행 안 되고 종료될 수 있어
    // waitUntil로 감싸서 응답 이후에도 끝까지 처리되도록 명시적으로 등록
    waitUntil(processEvent(event, isMention));
    return;
  }

  // 그 외 이벤트는 무시하되 200으로 응답
  res.status(200).send("ok");
};
