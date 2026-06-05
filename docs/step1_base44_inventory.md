# STEP1 · Base44 앱 인벤토리 (AXOS)

> 데이터모델·화면·API 분석 산출물. **상태: 스캐폴드** — Base44 MCP 도구로 채워 넣을 자리.
> Base44 MCP는 등록·인증 완료(2026-06-05). 도구 로드는 **세션 재시작 후** 가능(추가 OAuth 불필요).

## 앱 식별
- App Name: AXOS (가칭 — MCP 스캔으로 정확한 이름 확인)
- App ID: `6a225124042c1a7db62f27fb`
- Editor: https://app.base44.com/apps/6a225124042c1a7db62f27fb/editor
- API Base: `https://base44.app`
- MCP: `base44` (HTTP, https://app.base44.com/mcp) — `claude mcp list`에서 ✓ Connected

## 런타임 호출 패턴 (런북 §부록 — 확정)
- 함수: `POST https://base44.app/api/apps/6a225124042c1a7db62f27fb/functions/{name}`
- 엔티티 조회: `GET .../api/apps/6a22…/entities/{Entity}[/{id}]`
- 엔티티 생성: `POST .../entities/{Entity}` · 수정: `PUT .../entities/{Entity}/{id}`
- 공통 헤더: `Authorization: Bearer <token>`, `X-App-Id: 6a225124042c1a7db62f27fb`

---

## 1. 데이터 모델 (Entities) — TODO: MCP `list_entities`
| 엔티티 | 필드(타입) | 관계 | AXOS 매핑(판단/실행 어디서 쓰나) |
|--------|-----------|------|----------------------------------|
| _(채울 자리)_ | | | |

> 채운 뒤: 각 엔티티를 Databricks Bronze/Silver 테이블 + 브리지 계약과 매핑(STEP2/3, docs/04).

## 2. 함수 (Functions) — TODO: MCP `list_functions`
| 함수 | 입력 | 출력 | 용도 | AXOS 연계 |
|------|------|------|------|-----------|
| _(채울 자리)_ | | | | |

> AXOS에서 Base44가 브리지/n8n을 호출하거나 콜백 받는 함수를 식별 → 경험↔브리지 접점.

## 3. 화면 (Pages/Screens) — TODO: MCP 화면 조회
| 화면 | 역할 | AXOS 진입점 |
|------|------|-------------|
| _(채울 자리)_ | | Copilot(STEP5)/Agent(STEP6)/대시보드(STEP10) 어디에 연결되나 |

## 4. 인증 방식 — TODO
- Bearer / API Key 여부, 토큰 발급 경로.

---

## 다음 (이 문서 채운 후)
1. 엔티티 → Databricks 데이터모델(STEP2/3) 매핑표 작성.
2. 화면 → Copilot/Agent/대시보드 진입점 확정 → 브리지 InsightRequest source 매핑.
3. 함수 → 경험↔브리지↔실행 호출/콜백 계약 확정.
