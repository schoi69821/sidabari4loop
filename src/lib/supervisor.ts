import { invoke } from "@tauri-apps/api/core";
import { ptyWrite } from "./pty";

// Supervisor 자동 연속 루프 — IPC 래퍼 + 정지조건 평가 + PTY 주입 헬퍼.
// 백엔드 src-tauri/src/supervisor.rs 와 대응.

/// 프로젝트 폴더의 텍스트 파일을 안전하게 읽는다 (path traversal은 Rust에서 방어).
/// 파일이 없으면 null.
export async function readProjectText(
  directory: string,
  relative: string,
): Promise<string | null> {
  return await invoke<string | null>("read_project_text", { directory, relative });
}

/// Claude Code 트랜스크립트에서 현재 컨텍스트 점유(토큰)를 추정해 가져온다.
/// 파일이 없거나 usage를 못 찾으면 null. (Rust supervisor::context_usage)
export type ContextUsage = {
  /// input + cache_creation + cache_read (현재 컨텍스트 토큰 합).
  total_input_tokens: number;
  /// 마지막 응답 생성 토큰 (참고용).
  output_tokens: number;
  /// 분모(컨텍스트 윈도우).
  context_window: number;
};

export async function getContextUsage(
  transcriptPath: string,
  contextWindow: number,
): Promise<ContextUsage | null> {
  return await invoke<ContextUsage | null>("context_usage", {
    transcriptPath,
    contextWindow,
  });
}

/// 컨텍스트 점유 백분율(0~100, 반올림). 측정 불가면 null.
export function contextUsagePct(u: ContextUsage | null): number | null {
  if (!u || u.context_window <= 0) return null;
  return Math.round((u.total_input_tokens / u.context_window) * 100);
}

/// 기본 운영 프롬프트 — 설정의 "기본값 불러오기" 버튼이 입력란에 채운다.
/// 현재 계약(docs/PROGRESS.md · TASK_COMPLETE · OPEN: · HALT:)에 맞춰져 있다.
/// 옛 명칭(MEMORY.md / EXPERIMENT_COMPLETE)을 쓰지 않는다.
export const DEFAULT_OPERATING_PROMPT = `너는 외부 감독 도구(Sidabari4Loop)가 운전하는 루프 검증용 에이전트다. 아래를 지켜라.

[감독 루프 — 너의 역할]
- "한 턴 = 한 단계". 다음 '한 단계'만 수행하고 '턴을 종료'한다. 여러 단계를 한 턴에 하지 말 것.
- 네가 턴을 끝내면 Sidabari4Loop 이 컨텍스트를 정리하고 이 프롬프트를 다시 준다.
  진행 상태는 docs/PROGRESS.md '파일'에 있으니, 매 턴 그 파일을 다시 읽고 이어가라.
- docs/PROGRESS.md 의 이름·위치를 바꾸지 마라. 감독 루프는 오직 docs/PROGRESS.md 만 추적한다(MEMORY.md 등 금지).
- 사용자에게 아무것도 묻지 말 것. 모호하면 추측해서 진행하지 말고 OPEN 줄로 남겨라.

[프로젝트 규율 — 매 step 공통]
- 루트 CLAUDE.md 와 관련 @docs/*.md 의 요구사항을 그대로 따른다. 요구사항과 어긋나거나 모호하면 임의 해석하지 말고 OPEN 줄로 남긴다.
- TDD 필수: 도메인 로직 step 은 Red→Green→Refactor 로 수행한다. 실패하는 테스트를 먼저 쓰지 않고는 비즈니스 로직을 추가하지 않는다.
- 테스트 메서드명·커밋 메시지에 요구사항 ID 를 참조한다(예: AP042_휴가일수_주말과공휴일제외).
- 절대 규칙(어기면 그 step 은 잘못된 것이다):
  · Docker 미사용(Windows 네이티브) · 개인키 서버 비저장(공개키만) · 파일은 백엔드 경유(presigned 금지)
  · 권한은 백엔드 RBAC 로 강제, 역할은 토큰에 넣지 않고 매 요청 판정(FND-010), 프론트 라우트 가드는 보조
  · 스키마는 Flyway 마이그레이션 · 시각·타임존은 KST(Asia/Seoul) 고정 · 시간 의존 로직은 Clock 주입

[이번 턴]
1) docs/PROGRESS.md 와 docs/BUILD_ORDER.md 를 읽는다.
2) PROGRESS '## 다음 할 일'이 가리키는 step 1개만 BUILD_ORDER 정의대로 수행한다.
   - 도메인 로직 step 은 TDD(Red→Green→Refactor)로. 인프라/스캐폴딩 step 도 가능한 한 빈 테스트가 도는 상태까지.
3) 검증 게이트(이 step 의 '완료 기준'을 실제로 확인):
   - 관련 테스트를 실제로 실행해 통과(그린)를 확인한다.
   - 빌드가 성공하는지 확인한다.
   - 기존에 통과하던 테스트가 깨지지 않았는지(회귀 없음) 확인한다.
   - 게이트를 통과하지 못하면 같은 step 을 고쳐 그린으로 만든다. 그래도 못 풀면 OPEN(또는 HALT)로 남긴다.
4) docs/PROGRESS.md 의 '## 다음 할 일'을 다음 step 으로 갱신하고
   (진행 로그 1줄 append: \`<stepID> <한 일> <테스트 결과>\`, 끝난 OPEN: 줄 제거) '턴을 종료'한다.

[미해결] 지금 못 풀거나 사람이 정해야 할 항목은 docs/PROGRESS.md 에
  'OPEN: <내용>' 또는 'OPEN[01]: <내용>' 줄로 남긴다(줄 시작·콜론 필수).
[완료] BUILD_ORDER 의 모든 step 이 끝나고 미해결(OPEN) 줄이 하나도 없으면
  docs/PROGRESS.md 에 'TASK_COMPLETE' 한 줄을 적는다(그러면 Sidabari4Loop 이 루프를 멈춘다).
[정지] 어떤 step 을 도저히 수행할 수 없으면 docs/PROGRESS.md 에 'HALT: <사유>' 를 적고 종료한다.
`;

export type LoopDecision = {
  decision: "continue" | "complete" | "halt";
  reason: string;
};

/// docs/PROGRESS.md 내용으로 루프 지속 여부를 판정한다.
///  - TASK_COMPLETE 줄이 있고 미해결(OPEN) 줄이 없으면 → complete (완료 정지)
///  - HALT: 줄이 있으면 → halt (정지)
///  - 그 외 → continue
///
/// 미해결(OPEN)·HALT 검출은 안전 게이트다. false negative(신호를 못 잡음)는 "완료 오판·정지"
/// 또는 "멈춰야 하는데 계속함"으로 이어져 위험하고, false positive는 루프가 더 도는 것뿐이라
/// 안전하다. 그래서 위험 방향으로 잘 안 틀리도록 관대하게 매칭한다: 들여쓰기·`- `/`* ` 불릿
/// 허용, ID는 임의(OPEN[3]:), 단 콜론은 필수. `## OPEN ISSUES`(콜론 없음)·산문은 제외된다.
export function evaluateLoopSignal(memoryText: string): LoopDecision {
  const lines = memoryText.split(/\r?\n/);
  const hasComplete = lines.some((l) => /TASK_COMPLETE/.test(l));
  const hasOpen = lines.some((l) => /^\s*(?:[-*]\s+)?OPEN(?:\[\w+\])?:/.test(l));
  const haltLine = lines.find((l) => /^\s*(?:[-*]\s+)?HALT:/.test(l));

  if (hasComplete && !hasOpen) {
    return { decision: "complete", reason: "TASK_COMPLETE (미해결 없음)" };
  }
  if (haltLine) {
    return { decision: "halt", reason: haltLine.trim() };
  }
  return { decision: "continue", reason: "" };
}

// xterm/PTY 주입 — 브래킷 페이스트로 여러 줄을 한 번에 넣고(조기 제출 방지), 잠깐 뒤 Enter(\r)로 제출.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ENTER = "\r";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/// 운영 프롬프트(여러 줄 가능)를 입력창에 붙여넣고 제출한다.
export async function injectPrompt(sessionId: string, text: string): Promise<void> {
  await ptyWrite(sessionId, PASTE_START + text + PASTE_END);
  // 붙여넣기가 입력 버퍼에 반영될 시간을 준 뒤 Enter (paste와 Enter가 한 chunk로 합쳐지지 않게).
  await delay(120);
  await ptyWrite(sessionId, ENTER);
}

const ESC = "\x1b";

/// 슬래시 명령(/clear, /compact 등) 1개를 입력창에 제출한다.
/// 턴 종료 직후엔 입력 프롬프트가 아직 준비 안 됐을 수 있어 정착 지연을 둔다.
/// 재시도가 안전하도록 Esc로 남은 입력/메뉴를 먼저 정리한 뒤 친다.
export async function injectSlashCommand(sessionId: string, command: string): Promise<void> {
  // 턴 종료 후 입력 프롬프트가 준비될 시간.
  await delay(400);
  // 이전 시도의 잔여 입력이나 열린 메뉴 정리 (재시도 시 명령이 이어 붙는 것 방지).
  await ptyWrite(sessionId, ESC);
  await delay(80);
  await ptyWrite(sessionId, command);
  // 슬래시 명령 메뉴가 명령을 인식할 시간을 준 뒤 Enter.
  await delay(250);
  await ptyWrite(sessionId, ENTER);
}

/// /clear — 대화를 비우고 새 세션을 연다 (SessionStart source=clear 발화).
export async function injectClear(sessionId: string): Promise<void> {
  await injectSlashCommand(sessionId, "/clear");
}

/// /compact — 대화를 요약 압축한다 (압축 완료 시 SessionStart source=compact 발화).
/// 압축은 LLM 요약이라 /clear보다 오래 걸린다 — 호출부에서 대기 타임아웃을 길게 둘 것.
export async function injectCompact(sessionId: string): Promise<void> {
  await injectSlashCommand(sessionId, "/compact");
}

// 부트스트랩(Phase 0) — 새 프로젝트에 Sidabari4Loop을 태우기 전, 작업 상태 파일을 만들게 하는 1회용 프롬프트.
// 전제: CLAUDE.md가 이미 있다(스택·구조·범위는 거기서 읽는다). 부트스트랩은 CLAUDE.md를 만들지 않고
// docs/PROGRESS.md·docs/BUILD_ORDER.md만 생성한다. 형식 규약은 프롬프트에 직접 내장(자체 완결형).
// 루프를 켜지 않고 1회만 주입한다 — Claude는 파일을 만들고 멈춘다.
export type BootstrapInput = {
  projectName: string;
  /// 이번 부트스트랩에만 적용할 추가 지시(선택). 비우면 생략된다.
  note: string;
};

export function buildBootstrapPrompt(i: BootstrapInput): string {
  const name = i.projectName.trim() || "이 프로젝트";
  const note = i.note.trim();
  const noteBlock = note ? `\n## 이번 부트스트랩 추가 지시\n${note}\n` : "";
  return `너는 지금부터 이 프로젝트를 Sidabari4Loop 자율 루프로 개발할 준비를 한다.
이 턴은 셋업 전용이다. 아직 기능 개발(빌드)을 시작하지 마라.

## 먼저 읽어라 (전제)
프로젝트 루트의 CLAUDE.md를 읽어라. 이 프로젝트의 기술 스택·디렉토리 구조·규약·범위(무엇을 만드는지)가 거기 있다.
CLAUDE.md가 없으면 스택과 범위를 추측하지 말고, 작업을 멈춘 뒤 "CLAUDE.md가 필요하다"고만 보고하라.
${noteBlock}
## 이번 턴에 생성할 파일 (2개)
Sidabari4Loop 자율 루프가 쓰는 작업 상태 파일이다. CLAUDE.md는 이미 있으니 새로 만들지 마라.

### 1) docs/PROGRESS.md — 자율 루프의 상태 원본 (형식 엄수)
Sidabari4Loop이 이 파일을 줄 단위 정규식으로 검출하므로 형식을 반드시 지켜라:
- 이 파일의 이름·위치를 절대 바꾸지 마라. 감독 루프는 오직 docs/PROGRESS.md만 추적한다
  (docs/MEMORY.md 등 다른 이름으로 만들거나 옮기면 루프가 멈춘다).
- 미해결 항목은 줄 시작 "OPEN: 설명" 또는 "OPEN[01]: 설명"(콜론 필수)으로만 적는다.
  불릿("- OPEN: ...")·들여쓰기는 허용되지만, 콜론 없는 "## OPEN ISSUES" 헤딩만으로는 검출되지 않는다.
- "TASK_COMPLETE" 문자열을 절대 넣지 마라. 지금 넣으면 루프가 시작 즉시 "완료"로 오판해 정지한다.
  (모든 작업이 끝나는 마지막 턴에만 쓰는 마커다.)
- "HALT:"로 시작하는 줄도 지금은 넣지 마라(정지 신호다).
- "## 다음 할 일" 섹션에 턴 하나에 끝낼 크기의 '다음 한 단계'를 구체적으로 적어라.
골격:
# ${name} — 진행 상태 (PROGRESS)
## 다음 할 일
- (턴 하나에 끝낼 첫 단계)
## 미해결
OPEN[01]: (열린 결정/의문이 있으면. 없으면 이 줄 삭제)
## 진행 로그
- (턴마다 한 줄씩 append)

### 2) docs/BUILD_ORDER.md — 작업 정의
CLAUDE.md의 범위를 '턴 하나에 끝낼 수 있는 단계들의 순서'로 분해해 적어라. 큰 Phase로 묶고 그 안을 세부 단계로.

## 규칙
- 사람에게 질문으로 멈추지 마라. 합리적 기본값으로 진행하되, 정말 사람이 정해야 할 핵심 결정은
  docs/PROGRESS.md에 "OPEN[NN]: 결정 필요 내용" 줄로 남겨 검수 때 보이게 하라.
- 위 두 파일을 만든 뒤, 무엇을 만들었는지 요약하고 턴을 종료하라. 기능 코드 작성이나 의존성 설치는
  하지 마라 — 그건 사람 검수 후 자율 루프에서 한다.`;
}
