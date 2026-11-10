const express = require('express');
const cors = require('cors'); // 이 줄을 추가합니다.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const net2Router = require('./routes/net2.routes');
const { shuffle, dedupeQuestions, normalizeBookmarkIds, isRoundResume, scorePractical } = require('./lib/quiz-utils');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 설정
app.use(cors()); // 추가: 모바일 앱 및 외부 도메인 API 요청 허용
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/net2', net2Router);

// SQLite 데이터베이스 초기화
const dbPath = path.join(__dirname, 'feedback.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

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
`);

// 메모리 세션 저장소
const sessionStore = new Map();

// 1. 등록된 회차/연도 목록 조회 API (실기는 연도별 추출)
app.get('/api/quiz/rounds', (req, res) => {
    try {
        const type = req.query.type || 'practical';
        const isWritten = (type === 'written');
        const dataPath = isWritten 
            ? path.join(__dirname, 'data', 'written.json') 
            : path.join(__dirname, 'data', 'practical.json');
        
        if (!fs.existsSync(dataPath)) {
            return res.json([]);
        }

        const questions = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

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

            return res.json(sortedYears);
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

        res.json(sortedRounds);
    } catch (e) {
        console.error('회차/연도 목록 조회 오류:', e);
        res.status(500).json({ error: '목록 조회 실패' });
    }
});

// 2. 문제 출제 API
app.post('/api/quiz/new', (req, res) => {
    try {
        const { year, bookmarkIds, solvedIds, examType, subject, targetQuestionId, resumeIds } = req.body;
        const isWritten = (examType === 'written');
        const dataPath = isWritten
            ? path.join(__dirname, 'data', 'written.json')
            : path.join(__dirname, 'data', 'practical.json');

        if (!fs.existsSync(dataPath)) {
            return res.status(404).json({ error: '문제 데이터 파일을 찾을 수 없습니다.' });
        }

        const questions = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        let selectedQuestions = [];
        let label = isWritten ? "필기 모의고사" : "실기 모의고사";
        let examLike = false; // 실전 모의고사(랜덤/회차) 여부: 과락 판정 대상
        const bookmarkIdList = normalizeBookmarkIds(bookmarkIds);

        if (targetQuestionId) {
            selectedQuestions = questions.filter(q => q.id === parseInt(targetQuestionId, 10));
            label = "단일 문항 학습";
        } else if (isRoundResume(year, resumeIds)) {
            // 이어풀기: 저장해 둔 문항 id 순서 그대로 세션을 복원한다 (회차 풀이)
            const byId = new Map(questions.map(q => [q.id, q]));
            selectedQuestions = [...new Set(resumeIds)].map(id => byId.get(id)).filter(Boolean);
            label = (year === 'cbt' || year === 'all') ? (isWritten ? "필기 실전 모의고사 (100제)" : "실기 무작위 30문항") : `${year} 기출 풀이`;
            examLike = true;
        } else if (bookmarkIdList.length > 0) {
            selectedQuestions = questions.filter(q => bookmarkIdList.includes(q.id));
            label = "즐겨찾기 모의고사";
        } else if (year === 'sequential') {
            selectedQuestions = questions;
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

        if (sessionStore.size > 500) {
            const now = Date.now();
            for (const [key, value] of sessionStore.entries()) {
                if (now - value.createdAt > 24 * 60 * 60 * 1000) {
                    sessionStore.delete(key);
                }
            }
        }

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
        const dataPath = isWritten 
            ? path.join(__dirname, 'data', 'written.json') 
            : path.join(__dirname, 'data', 'practical.json');
        
        let questions = [];
        if (fs.existsSync(dataPath)) {
            questions = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        }

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

// 6. 의견 제보 API
app.post('/api/feedback', (req, res) => {
    try {
        const { appMode, message, fingerprint } = req.body;
        if (!message || !message.trim()) {
            return res.status(400).json({ error: "내용을 입력해 주세요." });
        }

        const stmt = db.prepare("INSERT INTO feedback (app_mode, message, fingerprint) VALUES (?, ?, ?)");
        stmt.run(appMode || "common", message.trim(), fingerprint || "UNKNOWN");
        res.json({ success: true });
    } catch (e) {
        console.error("제보 등록 오류:", e);
        res.status(500).json({ error: "제보 접수 중 오류가 발생했습니다." });
    }
});

// 7. 사용자 활동 로그 수집 API
app.post('/api/log', (req, res) => {
    try {
        const { fingerprint, action, detail } = req.body;
        if (!fingerprint || !action) {
            return res.status(400).json({ error: "필수 정보가 누락되었습니다." });
        }
        const stmt = db.prepare("INSERT INTO activity_logs (fingerprint, action, detail) VALUES (?, ?, ?)");
        stmt.run(fingerprint, action, JSON.stringify(detail || {}));
        res.json({ success: true });
    } catch (e) {
        console.error("로그 수집 오류:", e);
        res.status(500).json({ error: "활동 로그 저장 실패" });
    }
});

// 8. 관리자 통계 조회 API
// 비밀번호는 코드에 두지 않고 환경변수 ADMIN_PASSWORD로 받는다. 미설정이면 관리자 API는 비활성화된다.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

function isAdminAuthorized(req) {
    if (!ADMIN_PASSWORD) return false;
    const auth = req.headers['x-admin-key'] || req.query.key;
    return auth === ADMIN_PASSWORD;
}

app.get('/api/admin/stats', (req, res) => {
    if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "관리자 인증 실패" });
    }

    try {
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

        res.json({
            todayDau: todayDauRow.cnt,
            liveUsers: liveUsersRow.cnt,
            totalUsers: totalUsersRow.cnt,
            todayActions: todayActionsRow.cnt,
            featureStats: featureStats,
            recentUsers: recentUsers
        });
    } catch (e) {
        console.error("관리자 통계 오류:", e);
        res.status(500).json({ error: "통계 데이터 산출 실패" });
    }
});

// 9. 개별 사용자 상세 타임라인 API
app.get('/api/admin/user-detail', (req, res) => {
    if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "관리자 인증 실패" });
    }

    const { fp } = req.query;
    if (!fp) return res.status(400).json({ error: "식별자가 누락되었습니다." });

    try {
        const logs = db.prepare(`
            SELECT action, detail, datetime(created_at, '+9 hours') AS kst_time 
            FROM activity_logs 
            WHERE fingerprint = ? 
            ORDER BY created_at DESC 
            LIMIT 100
        `).all();

        const summary = db.prepare(`
            SELECT action, COUNT(*) AS cnt 
            FROM activity_logs 
            WHERE fingerprint = ? 
            GROUP BY action 
            ORDER BY cnt DESC
        `).all();

        res.json({ logs, summary });
    } catch (e) {
        console.error("사용자 상세 조회 오류:", e);
        res.status(500).json({ error: "사용자 활동 내역 조회 실패" });
    }
});

// 서버 구동
app.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 정상 구동 중입니다.`);
});