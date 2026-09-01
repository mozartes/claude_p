# AM AI Agent 업무 진단 설문 (am-ai-survey)

공공고객 담당 AM(약 70명) 대상, AI Agent 개발 우선순위를 진단하기 위한 무기명 사내 설문 웹앱입니다.

- 프론트: Next.js (App Router) + TypeScript + Tailwind CSS
- 저장소: Google Sheets (서비스 계정 인증)
- 관리자 대시보드: `/admin` (비밀번호 게이트 + 집계 차트 + CSV 다운로드)

이 문서는 **로컬 실행 → Google 연동 설정 → Vercel 배포**까지 순서대로, 막히기 쉬운 지점 위주로 상세히 설명합니다.

---

## 0. 사전 준비물

- Node.js 18 이상 (권장 20+)
- Google 계정 (Google Cloud 프로젝트를 만들 수 있는 계정)
- Vercel 계정 (GitHub 계정으로 가입 가능)
- 이 프로젝트를 올릴 GitHub 저장소 (또는 Vercel CLI로 직접 배포 가능)

---

## 1. 로컬에서 실행해보기

```bash
npm install
cp .env.example .env.local
# .env.local을 열어 4번 항목에서 발급받을 값들을 채워 넣습니다.
npm run dev
```

`http://localhost:3000` 접속 → 설문이 정상적으로 뜨는지 확인합니다.
(이 시점에는 `.env.local`이 비어 있어도 화면은 뜨지만, 마지막 "제출하기"를 누르면 오류가 납니다. 이는 정상이며 2~4단계를 마치면 해결됩니다.)

---

## 2. Google Cloud 프로젝트 및 서비스 계정 생성

응답을 Google Sheets에 저장하려면 **서비스 계정(service account)** 인증이 필요합니다. 서비스 계정은 "로봇 계정"이라고 생각하면 됩니다 — 이 앱이 사람 대신 Google Sheets API를 호출할 수 있게 해주는 전용 계정입니다.

### 2-1. Google Cloud 프로젝트 생성

1. https://console.cloud.google.com 접속 (사내/개인 Google 계정으로 로그인)
2. 상단 프로젝트 선택 드롭다운 → **새 프로젝트**
3. 프로젝트 이름 예: `am-ai-survey` → **만들기**
4. 생성된 프로젝트가 상단에 선택되어 있는지 확인 (다른 프로젝트가 선택된 채로 다음 단계를 진행하면 API가 활성화되지 않습니다)

### 2-2. Google Sheets API 활성화

1. 좌측 메뉴 또는 검색창에서 **"API 및 서비스" → "라이브러리"** 이동
2. "Google Sheets API" 검색 → 클릭 → **사용(Enable)** 버튼 클릭
3. (선택) "Google Drive API"도 함께 검색해서 활성화해두면 이후 확장 시 편합니다.

### 2-3. 서비스 계정 생성

1. **"API 및 서비스" → "사용자 인증 정보(Credentials)"** 이동
2. 상단 **"+ 사용자 인증 정보 만들기" → "서비스 계정"** 선택
3. 서비스 계정 이름 입력 (예: `am-survey-bot`) → **만들고 계속하기**
4. 역할(Role) 부여 단계는 **건너뛰어도 됩니다** ("계속" → "완료"). 시트 접근 권한은 이후 4단계에서 "시트 공유"로 직접 부여합니다.

### 2-4. 서비스 계정 키(JSON) 발급

1. 방금 만든 서비스 계정 이름을 클릭해서 상세 페이지로 이동
2. **"키(Keys)" 탭 → "키 추가" → "새 키 만들기"**
3. 키 유형: **JSON** 선택 → **만들기**
4. JSON 파일이 자동으로 다운로드됩니다. **이 파일은 재발급 전까지 다시 받을 수 없으니 안전한 곳에 보관**하세요.

JSON 파일 내용은 대략 이렇게 생겼습니다:

```json
{
  "type": "service_account",
  "project_id": "am-ai-survey-xxxxx",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n",
  "client_email": "am-survey-bot@am-ai-survey-xxxxx.iam.gserviceaccount.com",
  ...
}
```

여기서 필요한 값은 **`client_email`**과 **`private_key`** 두 가지입니다.

> ⚠️ **작년/어제 배포가 실패했던 가장 흔한 원인이 바로 이 `private_key` 값입니다.** 3단계 문서 하단의 "흔한 오류와 해결법"을 반드시 참고하세요.

---

## 3. Google Sheets 준비

### 3-1. 시트 생성 및 시트 탭 이름 설정

1. https://sheets.google.com 에서 새 스프레드시트 생성
2. 파일 이름 예: `AM AI Agent 설문 응답`
3. **하단 시트 탭 이름을 정확히 `Responses`로 변경**합니다. (기본값은 "시트1"입니다. 더블클릭해서 이름 변경)
   - 이 앱의 코드(`src/lib/googleSheets.ts`)가 `Responses`라는 탭 이름을 하드코딩해서 찾기 때문에, 이름이 다르면 데이터가 저장되지 않습니다.
4. 헤더 행은 **직접 입력할 필요 없습니다.** 앱이 첫 응답을 저장할 때 1행이 비어 있으면 자동으로 헤더를 채워 넣습니다.

### 3-2. 시트 URL에서 Sheet ID 추출

브라우저 주소창의 URL에서 아래 굵게 표시된 부분이 Sheet ID입니다.

```
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit#gid=0
                                        └────────────── 이 부분이 GOOGLE_SHEET_ID ──────────────┘
```

### 3-3. 서비스 계정과 시트 공유 (가장 자주 빠뜨리는 단계)

1. 시트 우측 상단 **"공유"** 버튼 클릭
2. 2-4단계에서 확인한 서비스 계정 이메일(`...@...iam.gserviceaccount.com` 형태)을 입력
3. 권한을 **"편집자(Editor)"**로 설정 → 공유
4. "Google 계정이 아닙니다" 같은 경고가 떠도 정상입니다 — 서비스 계정은 사람 계정이 아니라서 나오는 안내이니 그대로 진행하면 됩니다.

> 이 단계를 빠뜨리면 앱은 정상 배포되어도 제출 시 `403 Forbidden` 또는 `The caller does not have permission` 오류가 발생합니다.

---

## 4. 환경변수 채우기

`.env.example`을 복사해 `.env.local`(로컬용) 을 만들고, 아래 4가지 값을 채웁니다. Vercel에는 동일한 값을 5단계에서 다시 등록합니다.

| 변수명 | 값 | 비고 |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | JSON의 `client_email` | 그대로 복사 |
| `GOOGLE_PRIVATE_KEY` | JSON의 `private_key` | 아래 "private key 다루는 법" 참고 |
| `GOOGLE_SHEET_ID` | 3-2에서 추출한 ID | |
| `ADMIN_PASSWORD` | 원하는 비밀번호 | `/admin` 접속용, 별도 계정 시스템 없이 단일 비밀번호로 게이트 |

### private key 다루는 법 (로컬 `.env.local`)

JSON 파일의 `private_key` 값을 **큰따옴표로 감싼 채, `\n`을 문자 그대로 유지**해서 붙여넣습니다.

```
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"
```

코드(`src/lib/googleSheets.ts`)에서 `\n` 문자열을 실제 줄바꿈으로 변환해주는 처리(`.replace(/\\n/g, "\n")`)가 이미 들어있으므로, 굳이 여러 줄로 쪼개 붙여넣지 않아도 됩니다. **한 줄로, `\n`을 그대로 텍스트로 둔 채** 붙여넣는 것이 가장 안전합니다.

---

## 5. Vercel 배포

### 방법 A. GitHub 연동 (권장)

1. 이 프로젝트 폴더를 GitHub 저장소에 push
   ```bash
   git init
   git add .
   git commit -m "Initial commit: AM AI Agent survey app"
   git branch -M main
   git remote add origin <본인의 GitHub 저장소 URL>
   git push -u origin main
   ```
2. https://vercel.com/new 접속 → GitHub 저장소 선택 → **Import**
3. Framework Preset은 자동으로 **Next.js**로 인식됩니다. 별도 설정 불필요.
4. **"Environment Variables"** 섹션에서 4단계의 4개 변수를 하나씩 추가합니다.
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY` ← 아래 "Vercel에 private key 입력 시 주의" 참고
   - `GOOGLE_SHEET_ID`
   - `ADMIN_PASSWORD`
5. **Deploy** 클릭 → 1~2분 후 배포 완료

### 방법 B. Vercel CLI로 직접 배포

```bash
npm install -g vercel
vercel login
vercel            # 첫 배포 (질문에 답하며 프로젝트 연결)
vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL production
vercel env add GOOGLE_PRIVATE_KEY production
vercel env add GOOGLE_SHEET_ID production
vercel env add ADMIN_PASSWORD production
vercel --prod     # 환경변수 반영한 프로덕션 배포
```

> **환경변수를 나중에 추가/수정한 경우, Vercel은 자동으로 재배포하지 않습니다.** 반드시 "Redeploy"를 한 번 눌러줘야 새 환경변수가 반영됩니다. (Vercel 대시보드 → Deployments → 최신 배포 우측 "..." 메뉴 → Redeploy)

### Vercel에 private key 입력 시 주의

Vercel 대시보드의 환경변수 입력창에 붙여넣을 때도 **4단계와 동일하게 `\n`을 문자 그대로 유지한 한 줄 문자열**로 넣습니다. 즉 로컬 `.env.local`에 넣은 것과 완전히 같은 문자열을 그대로 복사해서 붙여넣으면 됩니다.

- 입력창에 여러 줄(실제 줄바꿈)로 붙여넣으면 값이 깨질 수 있습니다.
- 앞뒤에 큰따옴표(`"`)를 포함해서 붙여넣지 마세요. Vercel 환경변수 입력창은 값 자체만 받으므로, 큰따옴표는 빼고 `-----BEGIN PRIVATE KEY-----\n...` 부분만 붙여넣습니다. (`.env.local` 파일에서는 따옴표가 필요하지만, Vercel UI 입력창에서는 따옴표 없이 값만 입력합니다.)

---

## 6. 배포 후 확인 체크리스트

1. 배포된 URL 접속 → 인트로 화면이 뜨는지 확인
2. 설문을 끝까지 채우고 "제출하기" 클릭 → 감사 화면이 뜨는지 확인
3. Google Sheets를 열어 `Responses` 탭에 1행 헤더 + 방금 제출한 응답 1행이 쌓였는지 확인
4. 같은 브라우저로 새로고침 후 다시 접속 → "이미 응답하셨습니다" 화면이 뜨는지 확인 (localStorage 기반 중복 방지)
5. `/admin` 경로 접속 → `ADMIN_PASSWORD`로 로그인 → 대시보드에 방금 제출한 응답이 집계되어 보이는지 확인
6. `/admin`에서 "CSV 다운로드" 클릭 → 파일이 정상적으로 받아지는지 확인

---

## 7. 흔한 오류와 해결법 (배포가 실패했다면 먼저 확인)

| 증상 | 원인 | 해결 |
|---|---|---|
| 제출 시 "환경변수 OOO 가 설정되지 않았습니다" | Vercel에 환경변수 미등록 또는 오타 | Vercel 프로젝트 Settings → Environment Variables 확인, 변수명 철자 일치 확인 (대소문자 포함) |
| 제출 시 500 에러 + 로그에 `error:1E08010C` 또는 `DECODER routines` | `GOOGLE_PRIVATE_KEY`의 `\n`이 실제 줄바꿈으로 깨졌거나, 키 앞뒤가 잘림 | JSON 파일의 `private_key` 값을 다시 통째로 복사, 앞뒤 따옴표 포함 여부를 5단계 안내대로 맞추기 |
| 제출 시 403 / `The caller does not have permission` | 서비스 계정과 시트를 공유하지 않음 | 3-3단계대로 서비스 계정 이메일을 시트에 "편집자"로 공유 |
| 제출은 되는데 시트에 아무것도 안 쌓임 | 시트 탭 이름이 `Responses`가 아님 | 시트 탭 이름을 정확히 `Responses`로 변경 (대소문자까지 일치) |
| `GOOGLE_SHEET_ID`를 넣었는데도 404 | URL에서 ID를 잘못 잘라냄 (앞뒤에 `/d/`, `/edit` 일부가 섞임) | 3-2단계 예시처럼 `/d/`와 `/edit` 사이 문자열만 정확히 추출 |
| 환경변수를 새로 추가했는데도 계속 이전 오류가 남 | 재배포를 하지 않음 | Vercel 대시보드에서 Redeploy 실행 |
| 로컬(`npm run dev`)에서는 잘 되는데 Vercel에서만 실패 | 로컬 `.env.local`과 Vercel 환경변수 값이 다름(복붙 누락) | 두 값을 나란히 비교, 특히 `GOOGLE_PRIVATE_KEY` 끝부분(`\n-----END PRIVATE KEY-----\n`)이 잘리지 않았는지 확인 |
| `/admin` 로그인이 항상 실패 | `ADMIN_PASSWORD` 환경변수 미설정 | Vercel/로컬 환경변수에 `ADMIN_PASSWORD` 추가 후 재배포 |
| 모바일에서 매트릭스 문항이 표(가로 스크롤)로 보임 | 브라우저 창 폭이 md 브레이크포인트(768px) 이상 | 실제 모바일 기기나 개발자도구 반응형 모드에서 확인 (창을 줄이는 것만으로도 카드형으로 전환됨) |

그래도 해결되지 않으면, Vercel 대시보드 → 해당 배포 → **"Functions" 로그** 또는 **"Runtime Logs"**에서 `/api/submit` 요청의 에러 스택을 확인하면 원인을 바로 특정할 수 있습니다. (이 앱은 서버 콘솔에 상세 오류를, 클라이언트 화면에는 안전한 일반 메시지만 보여주도록 분리되어 있습니다.)

---

## 8. 데이터 스키마

한 응답 = Google Sheets 한 행. 컬럼 순서:

```
timestamp, q1, q2,
q3_1~q3_8, q4_1~q4_8, q5_1~q5_8,
q6_1위, q6_2위, q6_3위,
q7, q8, q9, q10, q11, q12, q13, q14, q15, q16, q17, q18
```

- 복수선택 문항(q2, q7, q12)은 선택 항목을 ` | `(파이프)로 이어붙여 저장하며, "기타"를 선택한 경우 `기타: <입력내용>` 형식으로 저장됩니다.
- q3~q5는 8개 업무 단계(코드상 `src/lib/workStages.ts`에 정의된 순서, 시트 헤더 순서와 동일) 각각의 1~5점 응답입니다.
- q6은 순위 문항으로, 1·2·3순위로 선택된 업무명을 각각 별도 컬럼에 저장합니다.

이 CSV는 그대로 별도의 "설문 결과 분석" 프롬프트(Claude 등)에 첨부해 분석할 수 있도록 설계되었습니다.

---

## 9. 프로젝트 구조 참고

```
src/
  app/
    page.tsx              # 설문 메인 페이지
    admin/page.tsx         # 관리자 대시보드
    api/submit/route.ts    # 설문 제출 API (Sheets append)
    api/admin/data/route.ts # 관리자 집계 데이터 API
    api/admin/csv/route.ts  # CSV 다운로드 API
  components/
    SurveyForm.tsx          # 설문 전체 흐름(인트로/문항/제출/감사)
    questions/              # 문항 유형별 컴포넌트
  lib/
    workStages.ts           # 8개 업무 단계 정의
    survey.ts               # 18개 문항 정의
    answers.ts               # 응답 타입 및 유효성 검증
    sheetSchema.ts            # 시트 컬럼/행 변환 로직
    googleSheets.ts            # Google Sheets API 클라이언트
    aggregate.ts                # 관리자 대시보드 집계 로직
```

문항 내용이나 업무 단계 명칭을 수정하려면 `src/lib/survey.ts`와 `src/lib/workStages.ts`만 고치면 되고, 시트 컬럼 구조는 `src/lib/sheetSchema.ts`에서 함께 관리되므로 두 파일을 같이 확인하세요.
