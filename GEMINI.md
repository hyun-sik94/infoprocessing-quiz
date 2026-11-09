# Gemini.md - IT 자격증 CBT 플랫폼 개발 가이드라인

## 1. 프로젝트 개요
- 프로젝트명: 정보처리기사 및 IT 자격증 스마트 기출 풀이 (합격패스)[cite: 17]
- 플랫폼 형태: 모바일 뷰(최대 너비 430px) 중심의 반응형 웹 SPA (Single Page Application)[cite: 17]
- 주요 목적: 정보처리기사 및 네트워크관리사 2급 등 IT 자격증 필기/실기 기출문제 풀이, 실시간 자동 채점, 약점 성과 분석 서비스 제공[cite: 17]
- 핵심 기능:
  - 큐넷(Q-Net) 2026년 정기 기사 3회 시험 일정 기반 D-Day 카운트다운 배지 및 모달[cite: 17]
  - CSS 변수 기반 다크 모드 / 라이트 모드 전환 (로컬스토리지 상태 보존 및 index.html 인라인 스크립트를 통한 초기 깜빡임 방지)[cite: 17]
  - 실기 부분점수 자동 계산 엔진(소수점 첫째 자리 내림) 및 보기 단어 자동 칩(Chip) 추출[cite: 17]
  - 화이트박스 순서도, 라우터 네트워크 토폴로지, UML 다이어그램 인라인 SVG 및 마크다운 파이프(|) 기반 고대비 표 자동 렌더링[cite: 17]
  - SQLite(better-sqlite3) 기반 사용자 접속/풀이 로그 수집(navigator.sendBeacon 우선 사용), 의견 제보 및 관리자 대시보드 (admin.html)[cite: 17]
  - 브라우저 로컬스토리지 기반 학습 이력, 즐겨찾기, 순차 풀이 이어하기, 데이터 백업/복원 (JSON)[cite: 17]

## 2. 기술 스택
- 백엔드 런타임: Node.js (v20 이상)[cite: 17]
- 웹 프레임워크: Express[cite: 17]
- 데이터베이스: SQLite3 (better-sqlite3 라이브러리 사용, WAL 모드 적용)[cite: 17]
- 프론트엔드: Vanilla JavaScript (ES6+), HTML5, CSS3[cite: 17]
- 데이터 저장소: JSON 파일 (과목별 기출문제 원본), 인메모리 Map (시험 세션 관리)[cite: 17]
- 주요 패키지: express, better-sqlite3, cors[cite: 17]

## 3. 디렉터리 및 주요 파일 구조
- server.js: Express 메인 서버 파일. 공통 미들웨어, 기존 정처기 API, 과목별 독립 라우터 마운트[cite: 17]
- routes/: 과목별 독립 라우터 디렉터리
  - net2.routes.js: 네트워크관리사 2급 전용 라우터 (/api/net2)
- controllers/: 과목별 비즈니스 로직 및 채점 컨트롤러 디렉터리
  - net2.controller.js: 네트워크관리사 2급 출제 및 채점 로직
- feedback.db: SQLite 데이터베이스 파일 (feedback 테이블, activity_logs 테이블 및 인덱스)[cite: 17]
- public/
  - index.html: 메인 웹앱의 뼈대. 초기 테마 적용 스크립트, 헤더 도구(D-Day, 테마 스위치), 뷰 렌더러, 하단 탭 바, 공통 모달 구성[cite: 17]
  - app.js: 프론트엔드 통합 컨트롤러. SPA 화면 전환, 시험 세션 관리, 타이머, 정답 확인, 성과 분석 리포트, URL 쿼리 파라미터 및 history.pushState/popstate 제어[cite: 17]
  - style.css: 글로벌 CSS 변수(--bg-body, --bg-card, --table-th-bg 등) 정의, 카드형 모바일 피드, 고대비 표 및 칩 디자인[cite: 17]
  - admin.html: 관리자 통계 페이지 (DAU, 실시간 접속자, 기능별 호출 횟수, 개별 유저 상세 타임라인)[cite: 17]
- data/
  - written.json: 정보처리기사 필기 기출문제 원본[cite: 17]
  - practical.json: 정보처리기사 실기 기출문제 원본[cite: 17]
  - net2/
    - written.json: 네트워크관리사 2급 필기 기출문제 원본 (50문항 체계)
    - practical.json: 네트워크관리사 2급 실기 기출문제 원본

## 4. AI 코딩 및 수정 필수 원칙

### 4.1. 환경 격리 및 세션 관리 원칙 (런타임 충돌 방지)
- server.js 및 백엔드 코드에는 브라우저 전용 객체(window, document, localStorage, navigator 등)를 절대로 사용하지 않습니다[cite: 17].
- public/app.js 및 프론트엔드 코드에는 Node.js 전용 모듈(require, fs, path, process 등)을 절대로 사용하지 않습니다[cite: 17].
- 시험 세션은 server.js 및 각 컨트롤러의 인메모리 Map 객체에서 관리하며, 세션 키는 과목별 접두사(예: NET2_세션ID)를 부여하여 격리합니다[cite: 17].
- 세션 크기가 500개를 초과할 경우 생성 후 24시간이 경과한 세션을 자동 정리하는 구조를 유지합니다[cite: 17].

### 4.2. 데이터 우선 수정 및 파싱 원칙
- 문제의 오탈자 수정, 보기 분리, 지문 레이아웃 교정 요청이 있을 경우 정규식 파서를 무리하게 수정하기보다 JSON 데이터 내 보기 항목에 파이프(|) 구분자를 추가하거나 데이터를 직접 교정하는 방식을 우선 적용합니다[cite: 17].
- 실기 복수 정답 문항은 데이터의 inputCount 속성값에 따라 다중 입력란을 렌더링하며, 정답 문자열에 포함된 구분자(' / ' 또는 ',')를 기준으로 입력값을 결합 및 채점합니다[cite: 17].
- 복잡한 다이어그램 문항은 별도 이미지 파일 대신 반응형 viewBox를 적용한 인라인 SVG 코드로 data 파일 내에 내장합니다[cite: 17].
- 프론트엔드에서 API 응답을 처리할 때는 parseSecurePayload() 래퍼 함수를 거쳐야 하며, 해설(desc) 출력 시에는 정규식을 통해 출처 태그를 제거한 후 렌더링합니다[cite: 17].

### 4.3. 계산 및 채점 무결성 원칙
- 평균 정답률 계산 시 점수 합계를 전체 문항 수로 나누어 100%를 초과하는 버그가 발생하지 않도록 주의합니다[cite: 17].
  - 평균 정답률 공식: Math.round(총 점수 합계 / 총 응시 횟수)[cite: 17]
  - 합격 판정 기준: 100점 만점 기준 60점 이상[cite: 17]
- 정보처리기사 필기 과목 분류(getSubjectName)는 기존 문항 ID 체계(2001~2020: 1과목, 2021~2040: 2과목, 2041~2060: 3과목, 2061~2080: 4과목, 2081~2100: 5과목)를 엄격히 보존합니다[cite: 17].
- 네트워크관리사 2급 필기는 50문항 기준 1문항당 2점(100점 만점 중 60점 이상 합격)으로 채점하며, 실기 문항은 배점 기준에 맞게 독립 컨트롤러에서 계산합니다.
- 실기 문항은 1문항당 기본 5점 배점으로 계산하며, 복수 정답 문항의 부분 점수 비율 계산(Math.floor((일치 개수 / 전체 정답 개수) * 5 * 10) / 10)을 보존합니다[cite: 17].

### 4.4. 로컬스토리지 키 네이밍 규격
- 정보처리기사:
  - 즐겨찾기 목록: 정처기_즐겨찾기_목록[cite: 17]
  - 풀이 이력 목록: 정처기_이력_목록[cite: 17]
  - 순차 풀이 저장: 정처기_순차풀이_중간저장[cite: 17]
- 네트워크관리사 2급:
  - 즐겨찾기 목록: net2_즐겨찾기_목록
  - 풀이 이력 목록: net2_이력_목록
  - 순차 풀이 저장: net2_순차풀이_중간저장
- 공통 설정:
  - 테마 모드: cbt_theme (light 또는 dark)[cite: 17]

  ### 4.5. 멀티 자격증 상태 격리 및 기본값 보존 원칙
- 전역 상태 관리 변수 currentCertification의 기본값은 무조건 'qnet'(정보처리기사)으로 고정합니다.
- 사용자가 명시적으로 상단 칩을 변경하기 전까지는 기존 정보처리기사 데이터, 큐넷 D-Day, 로컬스토리지 키가 100% 동일하게 로드되어야 합니다.
- 백엔드 API 호출 주소는 하드코딩하지 않고 getApiBase() 헬퍼 함수를 통해 동적으로 결정합니다.
  - qnet: /api/quiz
  - net2: /api/net2
- 모드 선택 화면(loadModeSelectionScreen)은 칩 선택 상태(currentCertification)에 따라 제목, 설명 문구, 회차 문항 수(필기 100문항 vs 50문항)가 동적으로 변경되는 단일 반응형 템플릿을 유지합니다.

### 4.6. AI 응답 형식 원칙 (코드 전용 출력)
- 사용자의 작업 요청 시 서론, 작업 요약, 단계별 설명, 결론 등의 서술형 텍스트를 일체 출력하지 않습니다.
- 불필요한 설명 없이 바로 마크다운 코드 블록으로 작성된 소스 코드만 출력합니다.
- 수정 또는 생성할 파일이 여러 개인 경우, 각 코드 블록의 첫 줄 주석에 파일 상대 경로(예: // public/app.js)를 반드시 표기하고 코드만 순차적으로 제시합니다.
- 코드에 대한 설명이 반드시 필요한 경우라도 본문 텍스트로 풀어쓰지 않고, 해당 코드 라인의 간결한 인라인 주석으로만 처리합니다.

### 4.7. 커밋 및 형상 관리 원칙
- 소스 수정 및 기능 테스트 완료 후 임의로 git commit/push를 수행하지 않습니다.
- 반드시 사용자가 명시적으로 커밋을 요청했을 때만 커밋 및 푸시 작업을 단계별로 진행합니다.

## 5. 주요 백엔드 API 명세

### 5.1. 정보처리기사 기존 API (하위 호환 영구 보존)[cite: 17]
- GET /api/quiz/rounds?type={written|practical}: 등록된 연도 및 회차 목록 조회[cite: 17]
- POST /api/quiz/new: 시험 세션 생성 및 문제 출제 (answer/desc 필드 제외)[cite: 17]
- POST /api/quiz/check-answer: 단일 문제 즉시 정답 및 해설 확인[cite: 17]
- POST /api/quiz/submit: 답안 최종 채점 및 점수/해설 리포트 생성[cite: 17]
- GET /api/quiz/search: 정답, 문제, 해설 기반 기출문제 키워드 검색[cite: 17]

### 5.2. 네트워크관리사 2급 전용 API (/api/net2)
- GET /api/net2/rounds?type={written|practical}: 네트워크관리사 2급 등록 회차 목록 조회
- POST /api/net2/new: 네트워크관리사 2급 시험 세션 생성 (세션 ID: NET2_접두사)
- POST /api/net2/check-answer: 단일 문제 즉시 정답 및 해설 확인
- POST /api/net2/submit: 답안 최종 채점 및 결과 리포트 생성 (필기 50문항 기준)
- GET /api/net2/search: 네트워크관리사 2급 기출문제 키워드 검색

### 5.3. 시스템 공통 API[cite: 17]
- POST /api/feedback: 기출문제 오류 및 기능 개선 의견 제보 저장 (feedback 테이블)[cite: 17]
- POST /api/log: 디바이스 핑거프린트 기반 활동 로그 적재 (activity_logs 테이블)[cite: 17]
- GET /api/admin/stats: 관리자 인증 키 기반 통계 조회[cite: 17]
- GET /api/admin/user-detail?fp={fingerprint}: 특정 사용자 상세 활동 로그 조회[cite: 17]

## 6. 개발 및 무결성 검증 명령어
- 의존성 설치: npm install[cite: 17]
- 누락 패키지 보완 설치: npm install better-sqlite3 cors express[cite: 17]
- 백엔드 서버 구동: node server.js (또는 npx nodemon server.js)[cite: 17]
- 정처기 실기 데이터 JSON 문법 검사:
  node -e "JSON.parse(require('fs').readFileSync('data/practical.json', 'utf8')); console.log('정처기 practical.json 문법 정상');"[cite: 17]
- 정처기 필기 데이터 JSON 문법 검사:
  node -e "JSON.parse(require('fs').readFileSync('data/written.json', 'utf8')); console.log('정처기 written.json 문법 정상');"[cite: 17]
- 네트워크관리사 2급 데이터 JSON 문법 검사:
  node -e "JSON.parse(require('fs').readFileSync('data/net2/written.json', 'utf8')); console.log('네트워크관리사 written.json 문법 정상');"
- SQLite WAL 모드 검증:
  node -e "const db = require('better-sqlite3')('feedback.db'); db.pragma('journal_mode = WAL'); console.log('DB 연동 정상');"[cite: 17]
- 프론트엔드 수정 시 캐시 갱신:
  public/style.css 또는 public/app.js 수정 후에는 반드시 public/index.html 내의 로드 태그 쿼리 스트링(?v=YYYYMMDD_NN) 버전을 함께 올립니다[cite: 17].

## 7. 멀티 자격증 확장 가이드 (네트워크관리사 2급, SQLD)
- 기존 정보처리기사 엔드포인트(/api/quiz)는 하위 호환성을 위해 영구 보존하며 절대 임의로 수정하거나 삭제하지 않습니다.
- 신규 자격증 추가 시 반드시 routes/ 및 controllers/ 하위에 전용 모듈을 독립 생성하고 server.js에 app.use('/api/{과목코드}', router) 형태로만 마운트합니다.
- 기출 데이터는 data/{과목코드}/written.json 및 practical.json 형태로 디렉터리를 엄격히 분리하여 관리합니다.
- 시험 세션 Map 객체나 브라우저 로컬스토리지 키 네이밍은 반드시 과목 접두사(예: net2_이력_목록, NET2_세션ID)를 부여하여 데이터 간섭을 방지합니다.