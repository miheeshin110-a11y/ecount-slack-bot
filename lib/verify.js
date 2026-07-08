// ============================================================
// Slack 요청 서명 검증
// - Vercel Node 서버리스 함수는 body-parser가 없으므로 raw body를 직접 읽음
// - Slack 공식 검증 알고리즘: v0:{timestamp}:{rawBody} 를 signing secret으로 HMAC-SHA256
// ============================================================
const crypto = require("crypto");

// req 스트림에서 원문 body(string) 읽기
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// 서명 검증. 통과하면 파싱된 payload(JSON 또는 form-urlencoded) 반환, 실패하면 null
async function verifySlackRequest(req) {
  const rawBody = await readRawBody(req);
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];

  if (!timestamp || !signature) return null;

  // 5분 이상 지난 요청은 재전송 공격으로 간주해 거부
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return null;

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
    .update(base)
    .digest("hex");
  const expected = `v0=${hmac}`;

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  // Events API는 JSON, Interactivity(버튼 클릭)는 form-urlencoded(payload=...)
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    return JSON.parse(rawBody);
  }
  const params = new URLSearchParams(rawBody);
  if (params.has("payload")) {
    return JSON.parse(params.get("payload"));
  }
  return Object.fromEntries(params);
}

module.exports = { verifySlackRequest, readRawBody };
