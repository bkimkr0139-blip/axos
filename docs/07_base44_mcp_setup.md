# 07 · Base44 MCP 연결 → STEP1 앱 분석 착수

> STEP1(데이터모델·화면·API 분석)을 하려면 Base44 MCP가 **이 세션에** 로드돼야 한다.
> 현재 막혀 있는 이유와, 사용자가 할 단 한 가지 동작을 정리한다.

---

## 1. 왜 지금 안 되나 (진단)

- 이 세션의 작업 디렉터리 `C:\Users\User\works\base44` 의 프로젝트 스코프에 **MCP 서버가 비어 있다** (`~/.claude.json` → `projects."C:/Users/User/works/base44".mcpServers = {}`).
- Base44 MCP는 **하위** 디렉터리들(`ymx-home`, `samsung`, `seoul-care-ai`)에만 등록돼 있다.
- AXOS 앱 URL(`.../apps/6a225124042c1a7db62f27fb/...`)은 인증 벽 → WebFetch는 403. 직접 못 읽는다.
- ⇒ STEP1은 **Base44 MCP 등록 + OAuth** 후에만 실행 가능. (표준 런북: `../새Base44앱_MCP연동_지시서.md`)

---

## 2. 사용자가 할 일 (택1)

AXOS 앱 정보: 이름 `AXOS`(가칭) · App ID `6a225124042c1a7db62f27fb` · API Base `https://base44.app`.

### 방법 A — 현재 디렉터리에 등록 (권장)
이 세션 디렉터리에서 Base44 MCP를 추가하면, **다음 세션부터** `works/base44`에서 시작한 모든 작업에 Base44 도구가 뜬다.

터미널에서 `!` 프리픽스로 실행하면 이 세션 로그에 결과가 남는다:
```
! claude mcp add --transport http base44 https://app.base44.com/mcp
```
> ⚠️ "동일 이름 중복 등록" 에러가 나면(부모/형제 스코프와 충돌) 이름을 바꾼다:
> `! claude mcp add --transport http base44-axos https://app.base44.com/mcp`

등록 후 **Claude Code 세션을 재시작**(이 디렉터리에서). 첫 MCP 호출 시 브라우저 OAuth 창 → 본인 계정 로그인 → **Allow** → 터미널에서 **Trust** 선택.

### 방법 B — 전용 디렉터리 분리
ymx-home처럼 AXOS 전용 작업 폴더를 두고 싶으면 `C:\Users\User\works\base44\axos`(이 repo)에서 등록:
```
! cd C:\Users\User\works\base44\axos ; claude mcp add --transport http base44-axos https://app.base44.com/mcp
```
이후 세션을 `...\axos`에서 시작.

> n8n MCP는 `works/base44`에서 시작해야 로드된다(메모리/RESUME). Base44 MCP까지 같은 스코프에 두면 **한 세션에서 판단(향후)·실행(n8n)·경험(Base44) 도구가 모두** 잡혀 가장 편하다 → **방법 A 권장**.

---

## 3. 연결 후 STEP1 자동 실행 (Claude가 할 일)

Base44 도구가 로드되면, 사용자 추가 작업 없이 다음을 조회·산출한다:

| 조회 | STEP1 산출물 |
|------|--------------|
| 엔티티 목록 + 필드 스키마 | **데이터 모델 분석** → `docs/step1_base44_inventory.md` ERD + 엔티티표 |
| 함수(Functions) 목록 + I/O | **API 분석** → 클라이언트/브리지 호출 인터페이스 |
| 화면/페이지 구조 | **화면 분석** → Copilot·Agent·대시보드(STEP5/10) 진입점 매핑 |
| 인증 방식 / Base URL | 런타임 호출 패턴 + 토큰 전략 |

이후 산출물을 Databricks 데이터 모델(STEP2/3)·브리지 계약(docs/04)과 매핑해 STEP1을 닫는다.

---

## 4. 체크리스트

- [ ] `works/base44`(또는 axos) 스코프에 `base44`/`base44-axos` MCP 등록
- [ ] 세션 재시작 → 첫 호출 OAuth → Allow → Trust
- [ ] MCP 앱 목록에 `6a225124042c1a7db62f27fb` 노출 확인 (없으면 계정 권한 점검 — 런북 §Phase4)
- [ ] 엔티티/함수/화면 스캔 → `docs/step1_base44_inventory.md` 생성
- [ ] Databricks/브리지 계약과 매핑 → STEP1 종료

---

**참고**: 런타임(앱 실제 동작)은 MCP가 아니라 REST다 — `POST https://base44.app/api/apps/6a225124042c1a7db62f27fb/functions/{name}`, 헤더 `Authorization: Bearer <token>`, `X-App-Id: 6a22…`. (런북 §부록) AXOS에서 Base44가 브리지/n8n을 호출하거나 콜백을 받을 때 이 채널을 쓴다.
