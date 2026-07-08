// ============================================================
// 슬랙 스레드 문맥 관련 공용 유틸
// - 봇이 시작한 스레드인지 판별
// - 스레드 안의 사람 메시지들을 하나의 문맥으로 재구성 (되묻기 이후 답장 처리용)
// ============================================================
const { WebClient } = require("@slack/web-api");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

let cachedBotUserId = null;
async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  const info = await slack.auth.test();
  cachedBotUserId = info.user_id;
  return cachedBotUserId;
}

async function isBotThread(channel, thread_ts) {
  const botId = await getBotUserId();
  const replies = await slack.conversations.replies({ channel, ts: thread_ts, limit: 50 });
  return (replies.messages || []).some((m) => m.user === botId || m.bot_id);
}

// 스레드 안의 사람 메시지들을 전부 모아 하나의 문맥으로 합침
async function getThreadUserText(channel, thread_ts) {
  const botId = await getBotUserId();
  const replies = await slack.conversations.replies({ channel, ts: thread_ts, limit: 50 });
  return (replies.messages || [])
    .filter((m) => m.user !== botId && !m.bot_id)
    .map((m) => (m.text || "").replace(/<@[^>]+>/g, "").trim())
    .filter(Boolean)
    .join("\n");
}

module.exports = { slack, getBotUserId, isBotThread, getThreadUserText };
