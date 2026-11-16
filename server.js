const express = require('express');
const cors = require('cors'); // 이 줄을 추가합니다.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const net2Router = require('./routes/net2.routes');
const { getSessionCount: getNet2SessionCount } = require('./controllers/net2.controller');
const { shuffle, dedupeQuestions, normalizeBookmarkIds, isRoundResume, scorePractical, pruneSessionStore } = require('./lib/quiz-utils');
const questionStore = require('./lib/question-store');
const { createStaticCache } = require('./lib/static-cache');

const app = express();
const PORT = process.env.PORT || 3000;

// 관리자 화면·API는 별도 포트로만 연다. 기본은 서버 내부(127.0.0.1)에서만 접속 가능 → SSH 터널로 접속한다.
// ADMIN_PORT=off 이면 관리자 기능을 끈다.
const ADMIN_PORT = process.env.ADMIN_PORT || 3100;
const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1';
const adminApp = express();

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILES = {
    written: path.join(__dirname, 'data', 'written.json'),
    practical: path.join(__dirname, 'data', 'practical.json')
};

// 메모리 세션: 24시간이 지나면 지우고, 최대 개수를 넘으면 가장 오래된 것부터 지운다.
// 세션은 공유 문제 객체를 가리키기만 하므로 세션 하나는 수십 KB 이하다.
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_MAX_COUNT = 5000;

// 미들웨어 설정
app.use(cors()); // 추가: 모바일 앱 및 외부 도메인 API 요청 허용
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(createStaticCache(PUBLIC_DIR)); // html/js/css/svg: 미리 압축해 둔 것을 보낸다
app.use(express.static(PUBLIC_DIR));    // 그 밖의 파일
app.use('/api/net2', net2Router);

// SQLite 데이터베이스 초기화
// DB_PATH 환경변수는 테스트용(실제 feedback.db를 건드리지 않기 위해). 운영은 기본값을 쓴다.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'feedback.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
// WAL에서는 NORMAL이어도 DB가 깨지지 않는다(전원이 끊기면 마지막 몇 건의 로그만 잃을 수 있음). 쓰기마다 디스크 동기화를 하지 않아 가볍다.
db.pragma('synchronous = NORMAL');

// 테이블 및 인덱스 초기화
db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_mode TEXT,
        message TEXT,
        fingerprint TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT,
        action TEXT,
        detail TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_fp ON activity_logs(fingerprint);

    CREATE TABLE IF NOT EXISTS notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// 제보 처리 상태(관리자 화면). 기존 제보는 'open'(미처리)으로 시작한다. 기존 행의 내용은 바꾸지 않는다.
const feedbackColumns = db.prepare("PRAGMA table_info(feedback)").all().map(c => c.name);
if (!feedbackColumns.includes('status')) db.exec("ALTER TABLE feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
if (!feedbackColumns.includes('handled_at')) db.exec("ALTER TABLE feedback ADD COLUMN handled_at DATETIME");

const SERVER_STARTED_AT = Date.now();

// 메모리 세션 저장소
const sessionStore = new Map();
setInterval(() => pruneSessionStore(sessionStore, SESSION_MAX_AGE_MS, SESSION_MAX_COUNT), 10 * 60 * 1000).unref();

// 1. 등록된 회차/연도 목록 조회 API (실기는 연도별 추출)
app.get('/api/quiz/rounds', (req, res) => {
    try {
        const type = req.query.type || 'practical';
        const isWritten = (type === 'written');
        const dataPath = isWritten ? DATA_FILES.written : DATA_FILES.practical;

        // 데이터가 바뀌기 전까지 같은 결과이므로 한 번만 계산한다
        const result = questionStore.memoize(dataPath, 'rounds', questions => buildRoundList(questions, isWritten));
        res.json(result || []);
    } catch (e) {
        console.error('회차/연도 목록 조회 오류:', e);
        res.status(500).json({ error: '목록 조회 실패' });
    }
});

function buildRoundList(questions, isWritten) {
        if (!isWritten) {
            // [실기] 문항수 없이 연도별로만 고유하게 추출
            const yearSet = new Set();
            questions.forEach(q => {
                const src = String(q.source || '').trim();
                const m = src.match(/(\d{4}\s*년(?:도)?)/);
                if (m) {
                    const cleanYear = m[1].replace(/\s+/g, '').replace('년도', '년');
                    yearSet.add(cleanYear);
                }
            });

            const sortedYears = Array.from(yearSet)
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
                .map(y => ({ name: y }));

            return sortedYears;
        }

        // [필기] 회차별 추출 및 문항수 집계
        const roundMap = new Map();
        questions.forEach(q => {
            const src = String(q.source || '').trim();
            const match = src.match(/(\d{4}\s*년(?:도)?\s*[\d·~,\s]+회(?:\s*통합)?)/);
            let roundName = "";
            if (match) {
                roundName = match[1].replace(/\s+/g, ' ').trim();
            } else {
                const yearMatch = src.match(/(\d{4}\s*년(?:도)?)/);
                roundName = yearMatch ? yearMatch[1].trim() : src;
            }

            if (roundName) {
                roundMap.set(roundName, (roundMap.get(roundName) || 0) + 1);
            }
        });

        const sortedRounds = Array.from(roundMap.entries()).map(([name, count]) => ({
            name: name,
            count: count
        })).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));

        return sortedRounds;
}

// 2. 문제 출제 API
app.post('/api/quiz/new', (req, res) => {
    try {
        const { year, bookmarkIds, solvedIds, examType, subject, targetQuestionId, resumeIds } = req.body;
        const isWritten = (examType === 'written');
        const dataPath = isWritten ? DATA_FILES.written : DATA_FILES.practical;

        // 공유 캐시(읽기 전용). 세션에는 이 객체들을 가리키는 배열만 저장된다.
        const questions = questionStore.getQuestions(dataPath);
        if (!questions) {
            return res.status(404).json({ error: '문제 데이터 파일을 찾을 수 없습니다.' });
        }
        let selectedQuestions = [];
        let label = isWritten ? "필기 모의고사" : "실기 모의고사";
        let examLike = false; // 실전 모의고사(랜덤/회차) 여부: 과락 판정 대상
        const bookmarkIdList = normalizeBookmarkIds(bookmarkIds);

        if (targetQuestionId) {
            selectedQuestions = questions.filter(q => q.id === parseInt(targetQuestionId, 10));
            label = "단일 문항 학습";
        } else if (isRoundResume(year, resumeIds)) {
            // 이어풀기: 저장해 둔 문항 id 순서 그대로 세션을 복원한다 (회차 풀이)
            const byId = questionStore.getQuestionMap(dataPath);
            selectedQuestions = [...new Set(resumeIds)].map(id => byId.get(id)).filter(Boolean);
            label = (year === 'cbt' || year === 'all') ? (isWritten ? "필기 실전 모의고사 (100제)" : "실기 무작위 30문항") : `${year} 기출 풀이`;
            examLike = true;
        } else if (bookmarkIdList.length > 0) {
            const wanted = new Set(bookmarkIdList);
            selectedQuestions = questions.filter(q => wanted.has(q.id));
            label = "즐겨찾기 모의고사";
        } else if (year === 'sequential') {
            selectedQuestions = questions.slice();
            label = isWritten ? "필기 전체 순차 풀이" : "실기 전체 순차 풀이";
        } else if (subject) {
            selectedQuestions = questions.filter(q => q.subject === subject);
            label = `${subject} 과목별 풀이`;
        } else if (year === 'cbt' || year === 'all') {
            const count = isWritten ? 100 : 30;
            // 회차 간 재출제된 동일 문항(문제+보기 동일)이 한 세션에 중복 출제되지 않도록 제거
            selectedQuestions = dedupeQuestions(shuffle(questions)).slice(0, count);
            label = isWritten ? "필기 실전 모의고사 (100제)" : "실기 무작위 30문항";
            examLike = true;
        } else {
            // 선택된 연도 또는 회차 매칭 (공백 무시)
            const cleanTarget = String(year || '').replace(/\s+/g, '').replace('년도', '년');
            selectedQuestions = questions.filter(q => {
                const cleanSource = String(q.source || '').replace(/\s+/g, '').replace('년도', '년');
                return cleanSource.includes(cleanTarget);
            });
            label = `${year} 기출 풀이`;
            examLike = true;
        }

        if (selectedQuestions.length === 0) {
            return res.json({ questions: [], quizLabel: label, sessionId: null });
        }

        const sessionId = "SESSION_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);

        // 실기 데이터에는 type 필드가 없다: 클라이언트(즐겨찾기 필터, 리뷰 배지)가 쓰므로 응답에서 보강
        const questionType = isWritten ? 'written' : 'practical';
        const clientQuestions = selectedQuestions.map(q => {
            const copy = { ...q, type: q.type || questionType };
            delete copy.answer;
            delete copy.desc;
            return copy;
        });

        sessionStore.set(sessionId, {
            questions: selectedQuestions,
            quizLabel: label,
            examLike: examLike,
            createdAt: Date.now()
        });
        if (sessionStore.size > SESSION_MAX_COUNT) pruneSessionStore(sessionStore, SESSION_MAX_AGE_MS, SESSION_MAX_COUNT);

        res.json({
            sessionId: sessionId,
            quizLabel: label,
            questions: clientQuestions
        });
    } catch (e) {
        console.error("문제 출제 오류:", e);
        res.status(500).json({ error: "문제 데이터를 불러오는 중 오류가 발생했습니다." });
    }
});

// 3. 단일 문제 정답 즉시 확인 API
app.post('/api/quiz/check-answer', (req, res) => {
    try {
        const { sessionId, questionId } = req.body;
        const session = sessionStore.get(sessionId);
        if (!session) {
            return res.status(400).json({ error: "만료되었거나 유효하지 않은 시험 세션입니다." });
        }

        const target = session.questions.find(q => q.id === parseInt(questionId, 10));
        if (!target) {
            return res.status(404).json({ error: "문제를 찾을 수 없습니다." });
        }

        res.json({
            answer: target.answer,
            desc: target.desc,
            choices: target.choices || null
        });
    } catch (e) {
        console.error("정답 확인 오류:", e);
        res.status(500).json({ error: "정답 확인 처리 중 오류가 발생했습니다." });
    }
});

// 4. 최종 시험 채점 및 제출 API
app.post('/api/quiz/submit', (req, res) => {
    try {
        const { sessionId, userAnswers } = req.body;
        const session = sessionStore.get(sessionId);
        if (!session) {
            return res.status(400).json({ error: "만료되었거나 유효하지 않은 시험 세션입니다." });
        }

        const questions = session.questions;
        const isWritten = (questions[0] && questions[0].type === 'written');
        let earnedScoreSum = 0;
        let isGwarak = false;
        let gwarakSubjects = [];

        const reviewData = questions.map(q => {
            const userAns = (userAnswers && userAnswers[q.id]) ? String(userAnswers[q.id]).trim() : "";
            const realAns = String(q.answer || "").trim();
            let isRight = false;
            let earnedScore = 0;
            let maxScore = isWritten ? 1 : 5;

            if (isWritten) {
                isRight = (userAns === realAns && userAns !== "");
                if (isRight) earnedScoreSum += 1;
            } else {
                // 실기 채점: 복수 정답 부분점수, '|' 대체 표기 지원 (lib/quiz-utils.js)
                const result = scorePractical(userAns, realAns, q.inputCount);
                isRight = result.isRight;
                earnedScore = result.earned;
                earnedScoreSum += earnedScore;
            }

            return {
                id: q.id,
                type: q.type || (isWritten ? 'written' : 'practical'),
                subject: q.subject || null,
                source: q.source,
                text: q.text,
                view: q.view || null,
                choices: q.choices || null,
                userAnswer: userAns,
                realAnswer: realAns,
                desc: q.desc,
                image: q.image || null,
                isRight: isRight,
                earnedScore: earnedScore,
                maxScore: maxScore
            };
        });

        const totalQuestions = questions.length;
        let finalScore = 0;

        if (isWritten) {
            finalScore = totalQuestions > 0 ? Math.round((earnedScoreSum / totalQuestions) * 100) : 0;
        } else {
            const totalMaxScore = totalQuestions * 5;
            finalScore = totalMaxScore > 0 ? Math.round((earnedScoreSum / totalMaxScore) * 100 * 10) / 10 : 0;
        }

        // 과락: 정처기 필기 실전 모의고사(랜덤·회차)에서 한 과목이라도 정답률 40% 미만이면 불합격
        let gwarakApplied = false;
        if (isWritten && session.examLike) {
            const bySubject = new Map();
            reviewData.forEach(r => {
                if (!r.subject) return;
                const s = bySubject.get(r.subject) || { total: 0, correct: 0 };
                s.total++;
                if (r.isRight) s.correct++;
                bySubject.set(r.subject, s);
            });
            if (bySubject.size >= 2) {
                gwarakApplied = true;
                bySubject.forEach((s, name) => {
                    if ((s.correct / s.total) * 100 < 40) gwarakSubjects.push(name);
                });
                isGwarak = gwarakSubjects.length > 0;
            }
        }

        const isPassed = (finalScore >= 60 && !isGwarak);

        res.json({
            score: finalScore,
            total: totalQuestions,
            isPassed: isPassed,
            isGwarak: isGwarak,
            gwarakApplied: gwarakApplied,
            gwarakSubjects: gwarakSubjects,
            reviewData: reviewData,
            quizLabel: session.quizLabel
        });
    } catch (e) {
        console.error("채점 제출 오류:", e);
        res.status(500).json({ error: "채점 처리 중 오류가 발생했습니다." });
    }
});

// 5. 문제 / 정답 / 해설 검색 API
app.get('/api/quiz/search', (req, res) => {
    try {
        const query = (req.query.query || req.query.answer || '').trim().toLowerCase();
        const type = req.query.type || 'practical';
        const field = req.query.field || 'answer';

        if (!query) return res.json([]);

        const isWritten = (type === 'written');
        const dataPath = isWritten ? DATA_FILES.written : DATA_FILES.practical;
        const questions = questionStore.getQuestions(dataPath) || [];

        const filtered = questions.filter(q => {
            if (isWritten) {
                if (field === 'desc') {
                    return q.desc && q.desc.toLowerCase().includes(query);
                } else {
                    let choiceAnswerText = '';
                    if (q.choices && Array.isArray(q.choices)) {
                        const ansIdx = parseInt(q.answer, 10) - 1;
                        if (q.choices[ansIdx]) {
                            choiceAnswerText = String(q.choices[ansIdx]).toLowerCase();
                        }
                    }
                    const rawAnswer = String(q.answer || '').toLowerCase();
                    return choiceAnswerText.includes(query) || rawAnswer.includes(query);
                }
            } else {
                if (field === 'text') {
                    return q.text && q.text.toLowerCase().includes(query);
                } else {
                    return q.answer && String(q.answer).toLowerCase().includes(query);
                }
            }
        });

        // 실기 데이터에는 type 필드가 없으므로 보강 (검색 결과에서 즐겨찾기할 때 필요)
        const questionType = isWritten ? 'written' : 'practical';
        res.json(filtered.map(q => (q.type ? q : { ...q, type: questionType })));
    } catch (e) {
        console.error("검색 오류:", e);
        res.status(500).json({ error: "검색 중 오류가 발생했습니다." });
    }
});

// 6. 요청 제한 (패키지 없이 서버 메모리에서 처리. 서버를 재시작하면 초기화된다)
// 접속 IP: 같은 서버나 사설망의 프록시를 거쳐 들어온 요청만 X-Forwarded-For를 믿고, 프록시가 마지막에 붙인 값을 쓴다.
// 외부에서 바로 들어온 요청의 X-Forwarded-For는 위조할 수 있으므로 무시한다.
const PRIVATE_ADDR = /^(?:::1$|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:)/i;

function getClientIp(req) {
    let remote = (req.socket && req.socket.remoteAddress) || '';
    if (remote.startsWith('::ffff:')) remote = remote.slice(7);
    const xff = req.headers['x-forwarded-for'];
    if (xff && PRIVATE_ADDR.test(remote)) {
        const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
    }
    return remote || 'unknown';
}

function createRateLimiter(limit, windowMs) {
    const hits = new Map();
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, 60 * 1000);
    if (timer.unref) timer.unref();

    function current(key) {
        const entry = hits.get(key);
        if (!entry || entry.resetAt <= Date.now()) return null;
        return entry;
    }

    return {
        // 1회 기록한다. 한도 안이면 true
        hit(key) {
            let entry = current(key);
            if (!entry) {
                entry = { count: 0, resetAt: Date.now() + windowMs };
                hits.set(key, entry);
            }
            entry.count += 1;
            return entry.count <= limit;
        },
        // 이미 한도를 다 썼으면 true (관리자 인증 실패 잠금용)
        isBlocked(key) {
            const entry = current(key);
            return !!entry && entry.count >= limit;
        },
        retryAfterSec(key) {
            const entry = current(key);
            return entry ? Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)) : 0;
        },
        reset(key) {
            hits.delete(key);
        }
    };
}

const logLimiter = createRateLimiter(120, 60 * 1000);            // 활동 로그: IP당 1분 120건
const feedbackLimiter = createRateLimiter(5, 10 * 60 * 1000);    // 제보: IP당 10분 5건
const adminFailLimiter = createRateLimiter(10, 15 * 60 * 1000);  // 관리자 인증 실패: IP당 15분 10회

function rejectTooMany(res, limiter, key, message) {
    res.set('Retry-After', String(limiter.retryAfterSec(key)));
    return res.status(429).json({ error: message });
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// 한국 시간 기준 날짜 문자열(YYYY-MM-DD)
function kstDateString(ms) {
    return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 자주 실행되는 INSERT 문은 한 번만 준비해 둔다(요청마다 SQL을 다시 해석하지 않도록)
const insertFeedbackStmt = db.prepare("INSERT INTO feedback (app_mode, message, fingerprint) VALUES (?, ?, ?)");
const insertLogStmt = db.prepare("INSERT INTO activity_logs (fingerprint, action, detail) VALUES (?, ?, ?)");

// 7. 의견 제보 API
const FEEDBACK_MAX_LENGTH = 2000; // 앱 입력칸 1,000자 + 분류·자격증·문항 정보

app.post('/api/feedback', (req, res) => {
    try {
        const { appMode, message, fingerprint } = req.body || {};
        if (typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ error: "내용을 입력해 주세요." });
        }
        if (message.length > FEEDBACK_MAX_LENGTH) {
            return res.status(400).json({ error: "내용이 너무 깁니다. 1,000자 이내로 적어 주세요." });
        }
        const ip = getClientIp(req);
        if (!feedbackLimiter.hit(ip)) {
            return rejectTooMany(res, feedbackLimiter, ip, "제보가 너무 잦습니다. 잠시 후 다시 보내 주세요.");
        }

        const mode = (typeof appMode === 'string' && appMode) ? appMode.slice(0, 20) : "common";
        const fp = (typeof fingerprint === 'string' && fingerprint) ? fingerprint.slice(0, 100) : "UNKNOWN";
        insertFeedbackStmt.run(mode, message.trim(), fp);
        res.json({ success: true });
    } catch (e) {
        console.error("제보 등록 오류:", e);
        res.status(500).json({ error: "제보 접수 중 오류가 발생했습니다." });
    }
});

// 8. 사용자 활동 로그 수집 API
const LOG_DETAIL_MAX_LENGTH = 2000;

app.post('/api/log', (req, res) => {
    try {
        const { fingerprint, action, detail } = req.body || {};
        if (typeof fingerprint !== 'string' || !fingerprint || typeof action !== 'string' || !action) {
            return res.status(400).json({ error: "필수 정보가 누락되었습니다." });
        }
        if (fingerprint.length > 100 || !/^[A-Z][A-Z0-9_]{0,39}$/.test(action)) {
            return res.status(400).json({ error: "형식이 올바르지 않습니다." });
        }
        const ip = getClientIp(req);
        if (!logLimiter.hit(ip)) {
            return rejectTooMany(res, logLimiter, ip, "요청이 너무 많습니다.");
        }

        let detailText = JSON.stringify((detail && typeof detail === 'object') ? detail : {});
        if (detailText.length > LOG_DETAIL_MAX_LENGTH) detailText = JSON.stringify({ truncated: true });

        insertLogStmt.run(fingerprint, action, detailText);
        res.json({ success: true });
    } catch (e) {
        console.error("로그 수집 오류:", e);
        res.status(500).json({ error: "활동 로그 저장 실패" });
    }
});

// 9. 공지 조회 API (앱 상단 배너). 표시 중인 공지 중 가장 최근 것 1개
app.get('/api/notice', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const row = db.prepare("SELECT id, message, level FROM notices WHERE active = 1 ORDER BY id DESC LIMIT 1").get();
        res.json({ notice: row || null });
    } catch (e) {
        console.error("공지 조회 오류:", e);
        res.json({ notice: null });
    }
});

// 10. 관리자 API (/api/admin/*)
// 비밀번호 우선순위: 관리자 화면에서 바꾼 비밀번호(DB admin_settings, scrypt 해시) → 환경변수 ADMIN_PASSWORD → 초기 비밀번호.
// 저장소가 공개라 초기 비밀번호는 해시만 둔다. 초기 비밀번호로 로그인하면 바꾸기 전까지 다른 관리자 기능을 막는다(2026-11-16 사용자 결정).
// 비밀번호를 잊으면 서버에서 node scripts/reset-admin-password.js 로 저장된 비밀번호를 지운다(초기 비밀번호로 돌아감).
// 비밀번호는 헤더(x-admin-key)로만 받는다. 주소(?key=)는 접속 기록과 브라우저 기록에 남으므로 받지 않는다.
const ADMIN_PASSWORD_ENV = process.env.ADMIN_PASSWORD || "";
const DEFAULT_ADMIN_PASSWORD_HASH = "scrypt$16384$8$1$1dfdb633a4867edea73e1e456ce18c83$fc37a5c56c1649ee3467790f9654710985ac35f08b5ec5e8ebf873a9b68c4ffb4c7f62025c8caa6d654aea69935d1785fd58611bb4cd142e6988751b08a4e2b6";
const ADMIN_PASSWORD_MIN_LENGTH = 8;
const ADMIN_PASSWORD_MAX_LENGTH = 128;

function sha256(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest();
}

function hashPassword(password) {
    const N = 16384, r = 8, p = 1;
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64, { N, r, p });
    return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPasswordHash(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltHex, hashHex] = parts;
    const expected = Buffer.from(hashHex, 'hex');
    let actual;
    try {
        actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    } catch (e) {
        return false;
    }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// 지금 유효한 비밀번호 정보
function currentAdminCredential() {
    const row = db.prepare("SELECT value, datetime(updated_at, '+9 hours') AS kst_time FROM admin_settings WHERE key = 'password_hash'").get();
    if (row) return { source: 'db', hash: row.value, updatedAt: row.kst_time };
    if (ADMIN_PASSWORD_ENV) return { source: 'env', hash: null, updatedAt: null };
    return { source: 'default', hash: DEFAULT_ADMIN_PASSWORD_HASH, updatedAt: null };
}

// 관리자 화면은 요청마다 비밀번호를 보낸다. 매번 scrypt를 다시 계산하지 않도록
// 마지막으로 맞았던 값의 SHA-256만 기억한다(비밀번호가 바뀌면 무효).
let verifiedPasswordCache = null;

function matchesAdminPassword(candidate, cred) {
    if (typeof candidate !== 'string' || !candidate || candidate.length > ADMIN_PASSWORD_MAX_LENGTH) return false;
    const digest = sha256(candidate);
    const credentialKey = `${cred.source}:${cred.hash || ''}`;
    if (verifiedPasswordCache && verifiedPasswordCache.credentialKey === credentialKey &&
        crypto.timingSafeEqual(verifiedPasswordCache.digest, digest)) {
        return true;
    }
    const ok = cred.source === 'env'
        ? crypto.timingSafeEqual(digest, sha256(ADMIN_PASSWORD_ENV))
        : verifyPasswordHash(candidate, cred.hash);
    if (ok) verifiedPasswordCache = { credentialKey, digest };
    return ok;
}

// 한글처럼 헤더에 그대로 넣을 수 없는 비밀번호를 위해 관리자 화면은 encodeURIComponent로 보낸다.
// 디코딩한 값을 먼저, 그다음 원문을 비교한다.
function adminKeyCandidates(req) {
    const raw = req.headers['x-admin-key'];
    if (typeof raw !== 'string' || !raw) return [];
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (e) { return [raw]; }
    return decoded !== raw ? [decoded, raw] : [raw];
}

// 관리자 전용 서버(별도 포트). 사용자 포트에는 관리자 화면과 API가 없다.
adminApp.disable('x-powered-by');
adminApp.use(express.json());
adminApp.use(createStaticCache(path.join(__dirname, 'admin'), { files: { '/': 'admin.html', '/admin.html': 'admin.html' } }));
adminApp.use(createStaticCache(PUBLIC_DIR, { files: { '/favicon.svg': 'favicon.svg' } }));

// 초기 비밀번호로 로그인한 상태에서도 쓸 수 있는 API
const ADMIN_ROUTES_BEFORE_PASSWORD_CHANGE = new Set(['GET /auth-status', 'POST /password']);

adminApp.use('/api/admin', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const ip = getClientIp(req);
    if (adminFailLimiter.isBlocked(ip)) {
        return rejectTooMany(res, adminFailLimiter, ip, "인증 실패가 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    }
    const cred = currentAdminCredential();
    if (!adminKeyCandidates(req).some(c => matchesAdminPassword(c, cred))) {
        adminFailLimiter.hit(ip);
        return res.status(401).json({ error: "관리자 인증 실패" });
    }
    adminFailLimiter.reset(ip);
    req.adminCredential = cred;
    if (cred.source === 'default' && !ADMIN_ROUTES_BEFORE_PASSWORD_CHANGE.has(`${req.method} ${req.path}`)) {
        return res.status(403).json({ error: "초기 비밀번호를 먼저 바꿔 주세요.", mustChangePassword: true });
    }
    next();
});

// 10-0. 비밀번호 상태와 변경
adminApp.get('/api/admin/auth-status', (req, res) => {
    const cred = req.adminCredential;
    res.json({ mustChangePassword: cred.source === 'default', source: cred.source, updatedAt: cred.updatedAt });
});

adminApp.post('/api/admin/password', (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        const cred = req.adminCredential;
        if (typeof currentPassword !== 'string' || !matchesAdminPassword(currentPassword, cred)) {
            adminFailLimiter.hit(getClientIp(req));
            return res.status(400).json({ error: "현재 비밀번호가 맞지 않습니다." });
        }
        if (typeof newPassword !== 'string' || newPassword.length < ADMIN_PASSWORD_MIN_LENGTH || newPassword.length > ADMIN_PASSWORD_MAX_LENGTH) {
            return res.status(400).json({ error: `새 비밀번호는 ${ADMIN_PASSWORD_MIN_LENGTH}~${ADMIN_PASSWORD_MAX_LENGTH}자로 정해 주세요.` });
        }
        if (verifyPasswordHash(newPassword, DEFAULT_ADMIN_PASSWORD_HASH)) {
            return res.status(400).json({ error: "초기 비밀번호는 다시 쓸 수 없습니다." });
        }
        if (newPassword === currentPassword) {
            return res.status(400).json({ error: "현재 비밀번호와 다른 비밀번호로 정해 주세요." });
        }
        db.prepare(`
            INSERT INTO admin_settings (key, value, updated_at) VALUES ('password_hash', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(hashPassword(newPassword));
        verifiedPasswordCache = null;
        res.json({ success: true });
    } catch (e) {
        console.error("관리자 비밀번호 변경 오류:", e);
        res.status(500).json({ error: "비밀번호 변경 실패" });
    }
});

// 개요 화면의 시험 필터 (통합이면 null)
const EXAM_FILTERS = {
    'qnet-written': { cert: 'qnet', mode: 'written' },
    'qnet-practical': { cert: 'qnet', mode: 'practical' },
    'net2-written': { cert: 'net2', mode: 'written' }
};
const EXAM_FILTER_SQL = "json_valid(detail) AND json_extract(detail, '$.cert') = ? AND json_extract(detail, '$.mode') = ?";

function getExamFilter(req) {
    return EXAM_FILTERS[req.query.exam] || null;
}

// 10-1. 오늘 통계
adminApp.get('/api/admin/stats', (req, res) => {
    try {
        // 시험 하나를 고른 경우: 그 시험의 시작·제출 로그만 센다
        const filter = getExamFilter(req);
        if (filter) {
            // 한국 시간 하루 [from, to) 동안 그 시험의 응시자·시작·제출·평균 점수
            const examDay = (from, to) => {
                const row = db.prepare(`
                    SELECT COUNT(DISTINCT fingerprint) AS examUsers,
                           SUM(action = 'START_EXAM') AS starts,
                           SUM(action = 'SUBMIT_EXAM') AS submits,
                           AVG(CASE WHEN action = 'SUBMIT_EXAM' THEN json_extract(detail, '$.score') END) AS avgScore
                    FROM activity_logs
                    WHERE action IN ('START_EXAM', 'SUBMIT_EXAM')
                          AND created_at >= datetime(?, '-9 hours') AND created_at < datetime(?, '-9 hours')
                          AND ${EXAM_FILTER_SQL}
                `).get(from, to, filter.cert, filter.mode);
                return {
                    examUsers: row.examUsers || 0,
                    starts: row.starts || 0,
                    submits: row.submits || 0,
                    avgScore: row.avgScore === null ? null : Math.round(row.avgScore * 10) / 10
                };
            };
            const now = Date.now();
            const yesterdayStart = kstDateString(now - 86400000) + ' 00:00:00';
            const todayStart = kstDateString(now) + ' 00:00:00';
            const tomorrowStart = kstDateString(now + 86400000) + ' 00:00:00';
            const today = examDay(todayStart, tomorrowStart);
            const total = db.prepare(`
                SELECT COUNT(DISTINCT fingerprint) AS cnt
                FROM activity_logs
                WHERE action IN ('START_EXAM', 'SUBMIT_EXAM') AND ${EXAM_FILTER_SQL}
            `).get(filter.cert, filter.mode);
            return res.json({
                exam: req.query.exam,
                todayExamUsers: today.examUsers,
                todayStarts: today.starts,
                todaySubmits: today.submits,
                todayAvgScore: today.avgScore,
                totalExamUsers: total.cnt || 0,
                yesterday: examDay(yesterdayStart, todayStart)
            });
        }

        const todayDauRow = db.prepare(`
            SELECT COUNT(DISTINCT fingerprint) AS cnt
            FROM activity_logs
            WHERE date(created_at, '+9 hours') = date('now', '+9 hours')
        `).get();

        const liveUsersRow = db.prepare(`
            SELECT COUNT(DISTINCT fingerprint) AS cnt
            FROM activity_logs
            WHERE created_at >= datetime('now', '-10 minutes')
        `).get();

        const totalUsersRow = db.prepare(`
            SELECT COUNT(DISTINCT fingerprint) AS cnt
            FROM activity_logs
        `).get();

        const todayActionsRow = db.prepare(`
            SELECT COUNT(*) AS cnt
            FROM activity_logs
            WHERE date(created_at, '+9 hours') = date('now', '+9 hours')
        `).get();

        const featureStats = db.prepare(`
            SELECT action, COUNT(*) AS total_calls, COUNT(DISTINCT fingerprint) AS unique_users
            FROM activity_logs
            WHERE date(created_at, '+9 hours') = date('now', '+9 hours')
            GROUP BY action
            ORDER BY total_calls DESC
        `).all();

        const recentUsers = db.prepare(`
            SELECT fingerprint, COUNT(*) AS total_events,
                   MAX(datetime(created_at, '+9 hours')) AS last_active
            FROM activity_logs
            GROUP BY fingerprint
            ORDER BY last_active DESC
            LIMIT 30
        `).all();

        // 어제(한국 시간) 방문자·활동 수: 개요 카드의 어제 대비 증감용
        const yesterdayRow = db.prepare(`
            SELECT COUNT(DISTINCT fingerprint) AS dau, COUNT(*) AS actions
            FROM activity_logs
            WHERE date(created_at, '+9 hours') = date('now', '+9 hours', '-1 day')
        `).get();

        res.json({
            todayDau: todayDauRow.cnt,
            liveUsers: liveUsersRow.cnt,
            totalUsers: totalUsersRow.cnt,
            todayActions: todayActionsRow.cnt,
            yesterdayDau: yesterdayRow.dau,
            yesterdayActions: yesterdayRow.actions,
            featureStats: featureStats,
            recentUsers: recentUsers
        });
    } catch (e) {
        console.error("관리자 통계 오류:", e);
        res.status(500).json({ error: "통계 데이터 산출 실패" });
    }
});

// 10-2. 개별 사용자 상세 타임라인
adminApp.get('/api/admin/user-detail', (req, res) => {
    const { fp } = req.query;
    if (typeof fp !== 'string' || !fp || fp.length > 100) {
        return res.status(400).json({ error: "식별자가 누락되었습니다." });
    }

    try {
        const logs = db.prepare(`
            SELECT action, detail, datetime(created_at, '+9 hours') AS kst_time
            FROM activity_logs
            WHERE fingerprint = ?
            ORDER BY created_at DESC
            LIMIT 100
        `).all(fp);

        const summary = db.prepare(`
            SELECT action, COUNT(*) AS cnt
            FROM activity_logs
            WHERE fingerprint = ?
            GROUP BY action
            ORDER BY cnt DESC
        `).all(fp);

        res.json({ logs, summary });
    } catch (e) {
        console.error("사용자 상세 조회 오류:", e);
        res.status(500).json({ error: "사용자 활동 내역 조회 실패" });
    }
});

// 10-3. 기간별 추이 (한국 시간 기준 일별)
adminApp.get('/api/admin/trends', (req, res) => {
    try {
        const days = clampInt(req.query.days, 1, 90, 14);
        const now = Date.now();
        const dates = [];
        for (let i = days - 1; i >= 0; i--) dates.push(kstDateString(now - i * 86400000));

        // 시험을 고르면 그 시험의 시작·제출 로그만 센다(users = 응시자 수)
        const filter = getExamFilter(req);
        const filterSql = filter ? `AND action IN ('START_EXAM', 'SUBMIT_EXAM') AND ${EXAM_FILTER_SQL}` : '';
        const params = [dates[0] + ' 00:00:00'].concat(filter ? [filter.cert, filter.mode] : []);

        // 한국 시간 첫날 0시를 UTC로 바꿔 비교한다(created_at 인덱스 사용)
        const rows = db.prepare(`
            SELECT date(created_at, '+9 hours') AS d,
                   COUNT(DISTINCT fingerprint) AS users,
                   COUNT(*) AS actions,
                   SUM(action = 'START_EXAM') AS starts,
                   SUM(action = 'SUBMIT_EXAM') AS submits
            FROM activity_logs
            WHERE created_at >= datetime(?, '-9 hours') ${filterSql}
            GROUP BY d
        `).all(...params);

        const byDate = new Map(rows.map(r => [r.d, r]));
        res.json({
            days,
            items: dates.map(d => {
                const r = byDate.get(d) || {};
                return { date: d, users: r.users || 0, actions: r.actions || 0, starts: r.starts || 0, submits: r.submits || 0 };
            })
        });
    } catch (e) {
        console.error("관리자 추이 오류:", e);
        res.status(500).json({ error: "추이 데이터 산출 실패" });
    }
});

// 10-4. 콘텐츠 통계 (시험 시작·제출 로그 기준)
const SESSION_KIND_LABELS = {
    sequential: '순차 풀이',
    subject: '과목 집중',
    bookmark: '즐겨찾기·오답 노트',
    target: '단일 문항',
    cbt: '랜덤 모의고사',
    all: '랜덤 모의고사'
};

function sessionKindLabel(year) {
    if (year === null || year === undefined || year === '') return '미상';
    return SESSION_KIND_LABELS[year] || '회차 풀이';
}

adminApp.get('/api/admin/content', (req, res) => {
    try {
        const days = clampInt(req.query.days, 1, 365, 30);
        const since = kstDateString(Date.now() - (days - 1) * 86400000) + ' 00:00:00';
        const filter = getExamFilter(req);
        const filterSql = filter ? `AND ${EXAM_FILTER_SQL}` : '';
        const params = [since].concat(filter ? [filter.cert, filter.mode] : []);

        const startRows = db.prepare(`
            SELECT json_extract(detail, '$.cert') AS cert,
                   json_extract(detail, '$.mode') AS mode,
                   json_extract(detail, '$.year') AS year,
                   COUNT(*) AS cnt
            FROM activity_logs
            WHERE action = 'START_EXAM' AND created_at >= datetime(?, '-9 hours') AND json_valid(detail) ${filterSql}
            GROUP BY cert, mode, year
        `).all(...params);

        const submitRows = db.prepare(`
            SELECT json_extract(detail, '$.cert') AS cert,
                   json_extract(detail, '$.mode') AS mode,
                   json_extract(detail, '$.year') AS year,
                   COUNT(*) AS cnt,
                   SUM(json_extract(detail, '$.score')) AS scoreSum,
                   COUNT(json_extract(detail, '$.score')) AS scoreCnt,
                   SUM(json_extract(detail, '$.isPassed') = 1) AS passed
            FROM activity_logs
            WHERE action = 'SUBMIT_EXAM' AND created_at >= datetime(?, '-9 hours') AND json_valid(detail) ${filterSql}
            GROUP BY cert, mode, year
        `).all(...params);

        const usersRow = db.prepare(`
            SELECT COUNT(DISTINCT fingerprint) AS cnt
            FROM activity_logs
            WHERE action = 'START_EXAM' AND created_at >= datetime(?, '-9 hours') ${filter ? `AND ${EXAM_FILTER_SQL}` : ''}
        `).get(...params);

        // 과목별 정답률: 제출 로그의 subjects { "과목명": [맞힌 수, 문항 수] } (2026-11-16 이후 필기 제출부터 기록)
        const subjectRows = db.prepare(`
            SELECT json_extract(l.detail, '$.cert') AS cert,
                   json_extract(l.detail, '$.mode') AS mode,
                   j.key AS subject,
                   COUNT(*) AS submits,
                   SUM(json_extract(j.value, '$[0]')) AS correct,
                   SUM(json_extract(j.value, '$[1]')) AS total
            FROM activity_logs AS l, json_each(l.detail, '$.subjects') AS j
            WHERE l.action = 'SUBMIT_EXAM' AND l.created_at >= datetime(?, '-9 hours') AND json_valid(l.detail)
                  ${filter ? "AND json_extract(l.detail, '$.cert') = ? AND json_extract(l.detail, '$.mode') = ?" : ''}
            GROUP BY cert, mode, subject
            ORDER BY cert, mode, subject
        `).all(...params);

        const emptyBucket = () => ({ starts: 0, submits: 0, scoreSum: 0, scoreCnt: 0, passed: 0 });
        const byCertMode = new Map();
        const byKind = new Map();
        const byRound = new Map();
        const bucket = (map, key, extra) => {
            if (!map.has(key)) map.set(key, Object.assign(emptyBucket(), extra));
            return map.get(key);
        };

        startRows.forEach(r => {
            const kind = sessionKindLabel(r.year);
            bucket(byCertMode, `${r.cert}|${r.mode}`, { cert: r.cert || null, mode: r.mode || null }).starts += r.cnt;
            bucket(byKind, kind, { kind }).starts += r.cnt;
            if (kind === '회차 풀이') bucket(byRound, `${r.cert}|${r.mode}|${r.year}`, { cert: r.cert || null, mode: r.mode || null, year: r.year }).starts += r.cnt;
        });
        submitRows.forEach(r => {
            const kind = sessionKindLabel(r.year);
            const targets = [
                bucket(byCertMode, `${r.cert}|${r.mode}`, { cert: r.cert || null, mode: r.mode || null }),
                bucket(byKind, kind, { kind })
            ];
            if (kind === '회차 풀이') targets.push(bucket(byRound, `${r.cert}|${r.mode}|${r.year}`, { cert: r.cert || null, mode: r.mode || null, year: r.year }));
            targets.forEach(t => {
                t.submits += r.cnt;
                t.scoreSum += r.scoreSum || 0;
                t.scoreCnt += r.scoreCnt || 0;
                t.passed += r.passed || 0;
            });
        });

        const finish = b => {
            const { scoreSum, scoreCnt, ...rest } = b;
            return {
                ...rest,
                avgScore: scoreCnt ? Math.round((scoreSum / scoreCnt) * 10) / 10 : null,
                passRate: b.submits ? Math.round((b.passed / b.submits) * 1000) / 10 : null
            };
        };
        const byStartsDesc = (a, b) => (b.starts - a.starts) || (b.submits - a.submits);

        res.json({
            days,
            examUsers: usersRow.cnt,
            byCertMode: [...byCertMode.values()].map(finish).sort(byStartsDesc),
            byKind: [...byKind.values()].map(finish).sort(byStartsDesc),
            topRounds: [...byRound.values()].map(finish).sort(byStartsDesc).slice(0, 15),
            subjects: subjectRows.map(r => ({
                cert: r.cert || null,
                mode: r.mode || null,
                subject: r.subject,
                submits: r.submits,
                correct: r.correct || 0,
                total: r.total || 0,
                rate: r.total > 0 ? Math.round(((r.correct || 0) / r.total) * 1000) / 10 : null
            }))
        });
    } catch (e) {
        console.error("관리자 콘텐츠 통계 오류:", e);
        res.status(500).json({ error: "콘텐츠 통계 산출 실패" });
    }
});

// 10-5. 서버 상태
function countQuestions(file) {
    try {
        const arr = questionStore.getQuestions(file);
        return Array.isArray(arr) ? arr.length : null;
    } catch (e) {
        return null;
    }
}

function fileSize(file) {
    try { return fs.statSync(file).size; } catch (e) { return 0; }
}

adminApp.get('/api/admin/server', (req, res) => {
    try {
        const mem = process.memoryUsage();
        const logInfo = db.prepare("SELECT COUNT(*) AS cnt, MIN(datetime(created_at, '+9 hours')) AS oldest FROM activity_logs").get();
        const feedbackInfo = db.prepare("SELECT COUNT(*) AS cnt, SUM(status = 'open') AS open FROM feedback").get();
        res.json({
            startedAt: SERVER_STARTED_AT,
            uptimeSec: Math.round(process.uptime()),
            nodeVersion: process.version,
            memory: { rss: mem.rss, heapUsed: mem.heapUsed },
            sessions: { qnet: sessionStore.size, net2: getNet2SessionCount() },
            questions: {
                written: countQuestions(path.join(__dirname, 'data', 'written.json')),
                practical: countQuestions(path.join(__dirname, 'data', 'practical.json')),
                net2Written: countQuestions(path.join(__dirname, 'data', 'net2', 'written.json'))
            },
            db: {
                sizeBytes: fileSize(dbPath) + fileSize(dbPath + '-wal'),
                activityLogs: logInfo.cnt,
                oldestLog: logInfo.oldest,
                feedback: feedbackInfo.cnt || 0,
                openFeedback: feedbackInfo.open || 0
            }
        });
    } catch (e) {
        console.error("서버 상태 조회 오류:", e);
        res.status(500).json({ error: "서버 상태 조회 실패" });
    }
});

// 10-6. 제보 목록과 처리 상태
const FEEDBACK_PAGE_SIZE = 30;

// 분류는 별도 컬럼 없이 메시지 앞의 [분류]에서 읽는다(기존 제보도 같은 방식으로 분류된다)
function feedbackCategory(message) {
    const m = /^\[([^\]\n]{1,20})\]/.exec(message || '');
    return m ? m[1] : '분류 없음';
}

adminApp.get('/api/admin/feedback', (req, res) => {
    try {
        const status = ['open', 'done'].includes(req.query.status) ? req.query.status : 'all';
        const mode = typeof req.query.mode === 'string' ? req.query.mode.slice(0, 20) : '';
        const category = typeof req.query.category === 'string' ? req.query.category.slice(0, 20) : '';
        const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
        const page = clampInt(req.query.page, 1, 100000, 1);

        const where = [];
        const params = [];
        if (status !== 'all') { where.push('status = ?'); params.push(status); }
        if (mode) { where.push('app_mode = ?'); params.push(mode); }
        if (q) {
            where.push("message LIKE ? ESCAPE '\\'");
            params.push('%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%');
        }

        const rows = db.prepare(`
            SELECT id, app_mode, message, fingerprint, status,
                   datetime(created_at, '+9 hours') AS kst_time,
                   datetime(handled_at, '+9 hours') AS handled_time
            FROM feedback
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY id DESC
        `).all(...params).map(r => ({ ...r, category: feedbackCategory(r.message) }));

        const filtered = category ? rows.filter(r => r.category === category) : rows;
        const totalPages = Math.max(1, Math.ceil(filtered.length / FEEDBACK_PAGE_SIZE));
        const current = Math.min(page, totalPages);

        const counts = db.prepare("SELECT SUM(status = 'open') AS open, SUM(status = 'done') AS done, COUNT(*) AS total FROM feedback").get();
        const modes = db.prepare("SELECT DISTINCT app_mode FROM feedback ORDER BY app_mode").all().map(r => r.app_mode).filter(Boolean);
        const categories = [...new Set(db.prepare("SELECT message FROM feedback").all().map(r => feedbackCategory(r.message)))].sort();

        res.json({
            items: filtered.slice((current - 1) * FEEDBACK_PAGE_SIZE, current * FEEDBACK_PAGE_SIZE),
            total: filtered.length,
            page: current,
            totalPages,
            counts: { open: counts.open || 0, done: counts.done || 0, total: counts.total || 0 },
            modes,
            categories
        });
    } catch (e) {
        console.error("제보 목록 조회 오류:", e);
        res.status(500).json({ error: "제보 목록 조회 실패" });
    }
});

adminApp.post('/api/admin/feedback/:id/status', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const status = req.body && req.body.status;
        if (!Number.isInteger(id) || id < 1 || !['open', 'done'].includes(status)) {
            return res.status(400).json({ error: "요청 형식이 올바르지 않습니다." });
        }
        const info = db.prepare(`
            UPDATE feedback
            SET status = ?, handled_at = CASE WHEN ? = 'done' THEN CURRENT_TIMESTAMP ELSE NULL END
            WHERE id = ?
        `).run(status, status, id);
        if (info.changes === 0) return res.status(404).json({ error: "제보를 찾을 수 없습니다." });
        res.json({ success: true });
    } catch (e) {
        console.error("제보 상태 변경 오류:", e);
        res.status(500).json({ error: "제보 상태 변경 실패" });
    }
});

// 10-7. 공지 관리
const NOTICE_LEVELS = ['info', 'warn'];
const NOTICE_MAX_LENGTH = 300;

adminApp.get('/api/admin/notices', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT id, message, level, active, datetime(created_at, '+9 hours') AS kst_time
            FROM notices
            ORDER BY id DESC
            LIMIT 50
        `).all();
        res.json({ items: rows });
    } catch (e) {
        console.error("공지 목록 조회 오류:", e);
        res.status(500).json({ error: "공지 목록 조회 실패" });
    }
});

adminApp.post('/api/admin/notices', (req, res) => {
    try {
        const message = typeof (req.body && req.body.message) === 'string' ? req.body.message.trim() : '';
        const level = NOTICE_LEVELS.includes(req.body && req.body.level) ? req.body.level : 'info';
        if (!message) return res.status(400).json({ error: "공지 내용을 입력해 주세요." });
        if (message.length > NOTICE_MAX_LENGTH) return res.status(400).json({ error: `공지는 ${NOTICE_MAX_LENGTH}자 이내로 적어 주세요.` });
        const info = db.prepare("INSERT INTO notices (message, level, active) VALUES (?, ?, 1)").run(message, level);
        res.json({ success: true, id: Number(info.lastInsertRowid) });
    } catch (e) {
        console.error("공지 등록 오류:", e);
        res.status(500).json({ error: "공지 등록 실패" });
    }
});

adminApp.post('/api/admin/notices/:id/active', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const active = req.body && req.body.active;
        if (!Number.isInteger(id) || id < 1 || typeof active !== 'boolean') {
            return res.status(400).json({ error: "요청 형식이 올바르지 않습니다." });
        }
        const info = db.prepare("UPDATE notices SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
        if (info.changes === 0) return res.status(404).json({ error: "공지를 찾을 수 없습니다." });
        res.json({ success: true });
    } catch (e) {
        console.error("공지 상태 변경 오류:", e);
        res.status(500).json({ error: "공지 상태 변경 실패" });
    }
});

adminApp.delete('/api/admin/notices/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다." });
        const info = db.prepare("DELETE FROM notices WHERE id = ?").run(id);
        if (info.changes === 0) return res.status(404).json({ error: "공지를 찾을 수 없습니다." });
        res.json({ success: true });
    } catch (e) {
        console.error("공지 삭제 오류:", e);
        res.status(500).json({ error: "공지 삭제 실패" });
    }
});

// 10-8. 오래된 활동 로그 정리. dryRun이 false로 명시될 때만 실제로 지운다(기본은 개수만 확인).
const LOG_RETENTION_MIN_DAYS = 30;
const LOG_RETENTION_MAX_DAYS = 3650;

adminApp.post('/api/admin/logs/cleanup', (req, res) => {
    try {
        const days = parseInt(req.body && req.body.days, 10);
        if (!Number.isInteger(days) || days < LOG_RETENTION_MIN_DAYS || days > LOG_RETENTION_MAX_DAYS) {
            return res.status(400).json({ error: `보관 기간은 ${LOG_RETENTION_MIN_DAYS}~${LOG_RETENTION_MAX_DAYS}일 사이로 정해 주세요.` });
        }
        const cutoff = `-${days} days`;
        if (!req.body || req.body.dryRun !== false) {
            const target = db.prepare(`
                SELECT COUNT(*) AS cnt,
                       MIN(datetime(created_at, '+9 hours')) AS oldest,
                       MAX(datetime(created_at, '+9 hours')) AS newest
                FROM activity_logs
                WHERE created_at < datetime('now', ?)
            `).get(cutoff);
            return res.json({ dryRun: true, days, count: target.cnt, oldest: target.oldest, newest: target.newest });
        }
        const info = db.prepare("DELETE FROM activity_logs WHERE created_at < datetime('now', ?)").run(cutoff);
        res.json({ dryRun: false, days, deleted: info.changes });
    } catch (e) {
        console.error("로그 정리 오류:", e);
        res.status(500).json({ error: "로그 정리 실패" });
    }
});

// 서버 구동
app.disable('x-powered-by');
app.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 정상 구동 중입니다.`);
});

// 관리자 화면: 기본은 서버 내부(127.0.0.1)에서만 열린다. 관리자 포트를 못 열어도 사용자 화면은 그대로 동작한다.
if (String(ADMIN_PORT).toLowerCase() !== 'off') {
    const adminServer = adminApp.listen(Number(ADMIN_PORT), ADMIN_HOST, () => {
        console.log(`관리자 화면: http://${ADMIN_HOST}:${ADMIN_PORT}/ (${ADMIN_HOST === '127.0.0.1' ? '서버 내부 전용, SSH 터널로 접속' : '외부 접속 허용'})`);
    });
    adminServer.on('error', (e) => {
        console.error(`관리자 포트 ${ADMIN_PORT}를 열지 못했습니다. 사용자 화면은 정상 동작합니다: ${e.message}`);
    });
}