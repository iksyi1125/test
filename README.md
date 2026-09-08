# Claude 토큰 사용량 실시간 모니터

Claude Code 가 로컬에 남기는 대화 기록(`~/.claude/projects/**/*.jsonl`)을 감시해서
토큰 사용량과 예상 비용을 **실시간**으로 보여주는 앱입니다. 외부 의존성이 없고 Node.js 20 이상만 있으면 됩니다.

- 웹 대시보드: 5시간 사용량 창, 분당 토큰 속도, 최근 24시간/일별 차트, 모델·세션·최근 호출 표
- 터미널 모드: 같은 정보를 터미널에서 2초마다 갱신
- 새 API 호출이 기록되면 `fs.watch` + SSE(Server-Sent Events)로 즉시(수백 ms 안에) 화면이 갱신됩니다
- API 키가 필요 없습니다. 네트워크로 아무것도 보내지 않습니다.

## 실행

```bash
git clone <this repo> && cd claude-usage-monitor
npm start                 # http://127.0.0.1:3141 열기
npm run cli               # 터미널 실시간 뷰
```

또는 직접:

```bash
node bin/claude-usage.js --port 3141
node bin/claude-usage.js --cli --range 7d --project my-app
```

| 옵션 | 설명 |
| --- | --- |
| `--port <n>` | 포트 (기본 3141, 환경변수 `PORT`) |
| `--host <h>` | 바인드 주소 (기본 127.0.0.1) |
| `--dir <path>` | 트랜스크립트 디렉터리. 여러 번 지정 가능. 기본은 `$CLAUDE_CONFIG_DIR/projects`, `~/.claude/projects`, `~/.config/claude/projects` 중 존재하는 것 |
| `--pricing <json>` | 모델 가격 덮어쓰기 (아래 참고) |
| `--range` / `--project` | CLI 모드의 기간(`today`, `7d`, `30d`, `all`)과 프로젝트 필터 |

## 설치 없이 브라우저에서 보기 (standalone)

`standalone/index.html` 은 서버 없이 동작하는 단일 HTML 파일입니다. 파일을 브라우저로 열고
**폴더 열기 · 실시간** 버튼으로 `~/.claude/projects` 를 선택하면 브라우저 안에서만 기록을 읽어
2초마다 새 호출을 반영합니다(Chrome·Edge의 File System Access API 사용). 다른 브라우저에서는
**파일 선택 · 1회** 로 한 번에 읽을 수 있습니다. 어디에도 업로드되지 않습니다.

다시 만들려면:

```bash
node scripts/build-standalone.mjs                                  # 예시 데이터 내장
node scripts/build-standalone.mjs --sample ~/.claude/projects --label "내 기록"   # 실제 기록 내장
```

## 화면 구성

**지금** (필터와 무관한 실시간 영역)

- **5시간 사용량 창**: Pro/Max 구독 한도가 적용되는 5시간 창 기준의 토큰·비용·호출 수와 남은 시간.
  첫 호출 시각을 정시로 내림한 시각이 창의 시작이고, 5시간이 지나거나 5시간 이상 쉬면 새 창이 열립니다.
- **최근 5분 속도**: 분당 토큰(tok/min)과 최근 1분 사용량.
- **최근 24시간**: 시간별 토큰 막대. 막대에 마우스를 올리면 입력/캐시/출력 내역이 나옵니다.

**필터** (오늘 · 7일 · 30일 · 전체, 프로젝트) 아래는 모두 같은 범위로 집계됩니다.

- 총 토큰 · 예상 비용 · 출력 토큰 · 캐시 적중률
- 일별 토큰 차트, 토큰 구성(입력 / 캐시 읽기 / 캐시 쓰기 / 출력)
- 모델별 · 세션별 표
- 최근 API 호출 (새 호출은 하이라이트되어 맨 위에 추가)

## 비용 계산

`src/pricing.js` 의 모델 패밀리별 단가(USD / 1M tokens)로 계산합니다.
캐시 쓰기는 TTL 에 따라 5분(입력가 ×1.25)과 1시간(입력가 ×2)을 구분하고, 캐시 읽기는 입력가 ×0.1
(Fable 5.1 계열은 $0.25 고정)입니다. 가격표에 없는 모델은 비용을 `?` 로 표시하고 합계에서 제외합니다.

구독 요금제(Pro/Max)를 쓰면 실제 청구액은 아니고 "API 로 썼다면 얼마인지"의 참고값입니다.

가격을 바꾸거나 새 모델을 추가하려면 JSON 파일을 만들어 `--pricing` 으로 넘기세요.
키는 모델 ID 접두어이고, 캐시 단가를 생략하면 입력가에서 자동 계산됩니다.

```json
{
  "claude-opus-5": { "input": 5, "output": 25, "cacheWrite5m": 6.25, "cacheWrite1h": 10, "cacheRead": 0.5 },
  "claude-new-model": { "input": 3, "output": 15 }
}
```

## 동작 원리

1. 트랜스크립트 디렉터리의 모든 `.jsonl` 을 훑어 `type: "assistant"` 줄의 `message.usage` 를 읽습니다.
2. 스트리밍 중에는 같은 `message.id` 가 content 블록마다 반복 기록되므로 `message.id + requestId` 로 중복을 제거합니다.
3. 파일별 오프셋을 기억해 새로 추가된 바이트만 읽습니다. 파일이 잘리거나 지워지면 해당 파일 이벤트를 버리고 다시 읽습니다.
4. `fs.watch(recursive)` 로 변경을 감지하고, 지원하지 않는 환경을 위해 2초 폴링을 함께 돌립니다.
5. 변경이 있으면 SSE 로 브라우저에 알리고, 브라우저는 `/api/summary` 를 다시 받아 그립니다.

## API

| 경로 | 설명 |
| --- | --- |
| `GET /api/summary?range=today&project=` | 집계 JSON (totals, byModel, days, hours, block, rate, sessions, recent) |
| `GET /api/events` | SSE 스트림. 변경 시 `change` 이벤트 |
| `GET /api/health` | 상태 확인 |

## 테스트

```bash
npm test
```

## 제한

- Claude Code 가 로컬에 남긴 기록만 집계합니다. claude.ai 웹/앱 대화나 다른 기기의 사용량은 포함되지 않습니다.
- 구독 한도의 실제 잔여량은 공개 API 가 없어 알 수 없습니다. 5시간 창은 토큰 사용량을 창 단위로 보여줄 뿐, 한도 대비 퍼센트는 아닙니다.
- 일별 집계는 이 앱을 실행하는 컴퓨터의 시간대를 따릅니다.
