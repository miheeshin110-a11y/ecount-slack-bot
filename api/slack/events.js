// ============================================================
// POST /api/slack/events
// Slack Event Subscriptions 의 Request URL 로 등록
// ============================================================
const { verifySlackRequest } = require("../../lib/verify");
const { slack, isBotThread, getThreadUserMessages } = require("../../lib/threadContext");
const { runQuery, runQueryWithHistory } = require("../../lib/threadFlow");
const { waitUntil } = require("@vercel/functions");

// 실제 처리 로직 - 응답을 이미 보낸 뒤 백그라운드로 실행됨
async function processEvent(event, isMention, isChannelThreadReply) {
  const channel = event.channel;

  try {
    let result;

    if (isChannelThreadReply) {
      const thread_ts = event.thread_ts;
      // 우리 봇이 시작한 스레드가 아니면 (다른 사람들끼리의 잡담 스레드) 조용히 무시
      const ourThread = await isBotThread(channel, thread_ts);
      if (!ourThread) return;

      const messages = await getThreadUserMessages(channel, thread_ts);
      result = await runQueryWithHistory(messages, event.user);
      await slack.chat.postMessage({ channel, thread_ts, text: result.text, blocks: result.blocks });
    } else {
      const text = event.text.replace(/<@[^>]+>/g, "").trim();
      const thread_ts = isMention ? event.ts : undefined;
      result = await runQuery(text, event.user);
      await slack.chat.postMessage({ channel, thread_ts, text: result.text, blocks: result.blocks });
    }
  } catch (err) {
    console.error(err);
    await slack.chat.postMessage({
      channel,
      thread_ts: event.thread_ts || (isMention ? event.ts : undefined),
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
  // 3) 채널/비공개채널 안에서, 봇이 시작한 스레드에 멘션 없이 답장한 경우
  const isChannelThreadReply =
    event?.type === "message" &&
    (event?.channel_type === "channel" || event?.channel_type === "group") &&
    !!event?.thread_ts &&
    event?.thread_ts !== event?.ts &&
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
