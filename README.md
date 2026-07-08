# 이카운트 재고봇 (Vercel 서버리스 버전)

Socket Mode 대신 **Slack Events API(HTTP 웹훅)** 방식으로 동작해서,
컴퓨터나 별도 서버 없이 **Vercel에만 배포**하면 24시간 작동합니다.
(기존 데이즈온 공지 대시보드, 세금계산서 앱과 동일한 배포 패턴)

## 동작 구조

```
슬랙 멘션 발생
  → Slack이 우리 Vercel URL(/api/slack/events)로 HTTP POST
  → 서명 검증 → Claude로 의도 파싱 → 이카운트 API 호출 → 슬랙에 응답 전송

주문서 확인 버튼 클릭
  → Slack이 /api/slack/interactions 로 HTTP POST
  → 버튼에 담아둔 주문 데이터로 이카운트 SaveSaleOrder 호출 → 메시지 업데이트
```

상태 저장소(DB) 없이, 주문 확인 버튼의 `value`에 주문 데이터 자체를 담아서
서버리스의 무상태(stateless) 특성에 맞게 설계했습니다.

## 폴더 구조

```
api/slack/events.js         ← app_mention 이벤트 처리
api/slack/interactions.js   ← 버튼 클릭 처리
lib/ecount.js                ← 이카운트 API 클라이언트
lib/claude.js                ← Claude 의도 파싱
lib/handlers.js               ← 재고/주문 응답 생성 공통 로직
lib/verify.js                  ← Slack 서명 검증
vercel.json                     ← 함수 실행시간(maxDuration) 설정
```

---

## 설치 순서

### 1. 이카운트 API 인증키 발급
1. 이카운트 로그인 → **Self-Customizing > API 인증키 발급**
2. 회사코드(COM_CODE), API 사용자 ID(USER_ID), API 인증키(API_CERT_KEY) 확인
3. 해당 사용자에 재고조회 + 주문서 등록 권한 부여

### 2. GitHub 리포지토리 생성
```bash
cd ecount-slack-bot-vercel
git init
git add .
git commit -m "init"
# GitHub에서 새 리포지토리 만든 후
git remote add origin https://github.com/본인계정/ecount-slack-bot.git
git push -u origin main
```

### 3. Vercel 프로젝트 생성 및 배포
1. https://vercel.com 로그인 → **Add New > Project**
2. 방금 만든 GitHub 리포지토리 선택 → Import
3. Framework Preset: **Other** 선택 (Next.js 아님)
4. **Environment Variables**에 아래 값 전부 입력:

   | Key | Value |
   |---|---|
   | `SLACK_BOT_TOKEN` | (4단계에서 발급) |
   | `SLACK_SIGNING_SECRET` | (4단계에서 발급) |
   | `ANTHROPIC_API_KEY` | console.anthropic.com에서 발급 |
   | `ECOUNT_COM_CODE` | 회사코드 |
   | `ECOUNT_USER_ID` | API 사용자 ID |
   | `ECOUNT_API_CERT_KEY` | API 인증키 |
   | `ECOUNT_ENV` | `sandbox` (테스트) 또는 `production` |
   | `ECOUNT_DEFAULT_WH` | 기본 출고창고 코드 |

5. **Deploy** 클릭 → 완료되면 `https://프로젝트명.vercel.app` 형태 URL이 생김
   → 이 URL을 이제부터 **BASE_URL**이라 부를게요

> ⚠️ Vercel **Hobby(무료)** 플랜은 함수 실행시간 제한이 있어요(보통 10초).
> Claude+이카운트 호출이 그 안에 안 끝나면 에러가 날 수 있으니,
> 응답이 자주 느리면 **Pro 플랜**으로 올리거나 `vercel.json`의 `maxDuration`을 플랜 한도에 맞게 조정하세요.

### 4. Slack App 생성 (Socket Mode 불필요!)
1. https://api.slack.com/apps → **Create New App** → **From scratch**
2. **OAuth & Permissions** → Bot Token Scopes 추가: `app_mentions:read`, `chat:write`
3. **Install to Workspace** → Bot Token(`xoxb-...`) 복사
4. **Basic Information** → Signing Secret 복사

### 5. Event Subscriptions 설정 (배포 후 진행)
1. **Event Subscriptions** → 토글 On
2. **Request URL**에 입력: `https://프로젝트명.vercel.app/api/slack/events`
   → Slack이 자동으로 challenge 검증 요청을 보내고, 우리 코드가 응답하면 **Verified ✅** 표시됨
3. **Subscribe to bot events** → `app_mention` 추가 → Save

### 6. Interactivity 설정 (버튼 클릭용)
1. 좌측 메뉴 **Interactivity & Shortcuts** → 토글 On
2. **Request URL**에 입력: `https://프로젝트명.vercel.app/api/slack/interactions`
3. Save

### 7. 채널에 봇 초대 후 테스트
```
/invite @이카운트재고봇
```
```
@이카운트재고봇 전체 재고 현황
```

---

## 실제 이카운트 API 응답 필드 맞추기

이카운트 응답 필드명은 계정/버전마다 다를 수 있어요. 처음 테스트 시 에러가 나면
Vercel 대시보드 → 해당 프로젝트 → **Logs** 탭에서 실제 에러 메시지를 확인할 수 있고,
그 내용을 그대로 알려주시면 `lib/ecount.js`의 필드명을 정확히 맞춰드릴게요.

## 배포 후 코드 수정 시

로컬에서 코드 수정 → GitHub에 push 하면 Vercel이 자동으로 재배포합니다 (기존 다른 프로젝트들과 동일).

```bash
git add .
git commit -m "필드명 수정"
git push
```
