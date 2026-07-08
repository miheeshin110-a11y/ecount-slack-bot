// ============================================================
// POST /api/slack/events
// Slack Event Subscriptions 의 Request URL 로 등록
// ============================================================
const { verifySlackRequest } = require("../../lib/verify");
const { getProducts } = require("../../lib/ecount");
const customers = require("../../lib/customers");
const { parseIntent } = require("../../lib/claude");
const {
  usageText,
  resolveInventoryQuery,
  buildInventoryText,
  resolveOrder,
  buildOrderConfirmBlocks,
} = require("../../lib/handlers");
const { WebClient } = require("@slack/web-api");
const { waitUntil } = require("@vercel/functions");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// 봇의 user ID를 캐시 (스레드가 우리 봇이 시작한 건지 판별하는 데 사용)
let cachedBotUserId = null;
async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  const info = await slack.auth.test();
  cachedBotUserId = info.user_id;
  return cachedBotUserId;
}

// 이 스레드에 우리 봇이 이미 메시지를 남긴 적 있는지 확인 (멘션 없는 후속 답장 감지용)
async function isBotThread(channel, thread_ts) {
  const botId = await getBotUserId();
  const replies = await slack.conversations.replies({ channel, ts: thread_ts, limit: 50 });
  return (replies.messages || []).some((m) => m.user === botId || m.bot_id);
}

// 스레드 안의 사람 메시지들을 전부 모아 하나의 문맥으로 합침 (봇이 되물은 뒤 이어지는 답장들 포함)
async function getThreadUserText(channel, thread_ts) {
  const botId = await getBotUserId();
  const replies = await slack.conversations.replies({ channel, ts: thread_ts, limit: 50 });
  return (replies.messages || [])
    .filter((m) => m.user !== botId && !m.bot_id)
    .map((m) => (m.text || "").replace(/<@[^>]+>/g, "").trim())
    .filter(Boolean)
    .join("\n");
}

// 실제 처리 로직 (재고조회/주문서/사용법 안내) - 응답을 이미 보낸 뒤 백그라운드로 실행됨
async function processEvent(event, isMention, isChannelThreadReply) {
  const channel = event.channel;
  let text;
  let thread_ts;

  if (isChannelThreadReply) {
    thread_ts = event.thread_ts;
    // 우리 봇이 시작한 스레드가 아니면 (다른 사람들끼리의 잡담 스레드) 조용히 무시
    const ourThread = await isBotThread(channel, thread_ts);
    if (!ourThread) return;
    // 스레드 안의 사람 메시지들을 전부 합쳐서 하나의 요청으로 재해석
    text = await getThreadUserText(channel, thread_ts);
  } else {
    text = event.text.replace(/<@[^>]+>/g, "").trim();
    thread_ts = isMention ? event.ts : undefined;
  }

  try {
    if (!text) {
      await slack.chat.postMessage({ channel, thread_ts, text: usageText() });
      return;
    }

    // 품목 마스터는 이카운트 API로, 거래처 마스터는 로컬 customers.js로 확보
    const products = await getProducts();
    const parsed = await parseIntent(text);

    if (parsed.intent === "inventory") {
      const resolved = await resolveInventoryQuery(parsed.query, products);
      const msg = await buildInventoryText(resolved, products);
      await slack.chat.postMessage({ channel, thread_ts, text: msg });
    } else if (parsed.intent === "order") {
      const order = await resolveOrder(parsed, customers, products);
      if (order.error) {
        await slack.chat.postMessage({ channel, thread_ts, text: order.error });
        return;
      }
      const confirm = await buildOrderConfirmBlocks(order, event.user);
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

  // 1) app_mention(채널 멘션)
  const isMention = event?.type === "app_mention";
  // 2) message.im(DM)
  const isDirectMessage =
    event?.type === "message" && event?.channel_type === "im" && !event?.bot_id && !event?.subtype;
  // 3) 채널/비공개채널 안에서, 봇이 시작한 스레드에 멘션 없이 답장한 경우 (되묻기에 대한 후속 답변)
  const isChannelThreadReply =
    event?.type === "message" &&
    (event?.channel_type === "channel" || event?.channel_type === "group") &&
    !!event?.thread_ts &&
    event?.thread_ts !== event?.ts && // 스레드의 첫 메시지 자체는 제외 (그건 app_mention으로 이미 처리됨)
    !event?.bot_id &&
    !event?.subtype;

  if (payload.type === "event_callback" && (isMention || isDirectMessage || isChannelThreadReply)) {
    // 먼저 200을 응답해 Slack의 3초 타임아웃 재전송을 막음
    res.status(200).send("ok");
    // Vercel Fluid compute 환경에서는 응답 후 코드가 실행 안 되고 종료될 수 있어
    // waitUntil로 감싸서 응답 이후에도 끝까지 처리되도록 명시적으로 등록
    waitUntil(processEvent(event, isMention, isChannelThreadReply));
    return;
  }

  // 그 외 이벤트는 무시하되 200으로 응답
  res.status(200).send("ok");
};
