const path = require('path');
const fs = require('fs');
const { dedupeQuestions, normalizeBookmarkIds, isRoundResume, scorePractical } = require('../lib/quiz-utils');

// ──────────────────────────────────────────────
// 네트워크관리사 2급 전용 인메모리 세션 저장소
// ──────────────────────────────────────────────
const net2SessionStore = new Map();

/**
 * 세션 자동 정리 (500개 초과 시 24시간 경과 세션 제거)
 */
function pruneOldSessions() {
    if (net2SessionStore.size > 500) {
        const now = Date.now();
        for (const [key, value] of net2SessionStore.entries()) {
            if (now - value.createdAt > 24 * 60 * 60 * 1000) {
                net2SessionStore.delete(key);
            }
        }
    }
}

/**
 * 데이터 파일 로드 헬퍼
 */
function loadQuestions(type) {
    const isWritten = (type === 'written');
    const dataPath = isWritten
        ? path.join(__dirname, '..', 'data', 'net2', 'written.json')
        : path.join(__dirname, '..', 'data', 'net2', 'practical.json');

    if (!fs.existsSync(dataPath)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
}

/**
 * Fisher-Yates 기반 배열 무작위 셔플 헬퍼
 */
function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ──────────────────────────────────────────────
// 컨트롤러 메서드
// ──────────────────────────────────────────────

/**
 * GET /rounds?type={written|practical}
 * 네트워크관리사 2급 등록 회차 목록 조회
 */
function getRounds(req, res) {
    try {
        const type = req.query.type || 'practical';
        const questions = loadQuestions(type);

        if (!questions) {
            return res.json([]);
        }

        const isWritten = (type === 'written');

        if (!isWritten) {
            // [실기] 연도별 고유 추출
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
        console.error('[NET2] 회차/연도 목록 조회 오류:', e);
        res.status(500).json({ error: '목록 조회 실패' });
    }
}

/**
 * POST /new
 * 네트워크관리사 2급 시험 세션 생성 (answer/desc 제외 후 반환)
 */
function getNewQuiz(req, res) {
    try {
        const { year, bookmarkIds, solvedIds, examType, subject, targetQuestionId, resumeIds } = req.body;
        const isWritten = (examType === 'written');
        const questions = loadQuestions(examType || 'practical');

        if (!questions) {
            return res.status(404).json({ error: '네트워크관리사 2급 문제 데이터 파일을 찾을 수 없습니다.' });
        }

        let selectedQuestions = [];
        let label = isWritten ? "필기 모의고사" : "실기 모의고사";
        const bookmarkIdList = normalizeBookmarkIds(bookmarkIds);

        if (targetQuestionId) {
            selectedQuestions = questions.filter(q => q.id === parseInt(targetQuestionId, 10));
            label = "단일 문항 학습";
        } else if (isRoundResume(year, resumeIds)) {
            // 이어풀기: 저장해 둔 문항 id 순서 그대로 세션을 복원한다 (회차 풀이는 문항 순서가 섞이므로 순서 보존이 필요)
            const byId = new Map(questions.map(q => [q.id, q]));
            selectedQuestions = [...new Set(resumeIds)].map(id => byId.get(id)).filter(Boolean);
            label = (year === 'cbt' || year === 'all') ? (isWritten ? "필기 실전 모의고사 (50제)" : "실기 무작위 20문항") : `${year} 기출 풀이`;
        } else if (bookmarkIdList.length > 0) {
            selectedQuestions = questions.filter(q => bookmarkIdList.includes(q.id));
            label = "즐겨찾기 모의고사";
        } else if (year === 'sequential') {
            selectedQuestions = questions;
            label = isWritten ? "필기 전체 순차 풀이" : "실기 전체 순차 풀이";
        } else if (subject) {
            selectedQuestions = shuffleArray(questions.filter(q => q.subject === subject));
            label = `${subject} 집중 풀이 (${selectedQuestions.length}문항)`;
        } else if (year === 'cbt' || year === 'all') {
            const count = isWritten ? 50 : 20;
            // 회차 간 재출제된 동일 문항(문제+보기 동일)이 한 세션에 중복 출제되지 않도록 제거
            selectedQuestions = dedupeQuestions(shuffleArray(questions)).slice(0, count);
            label = isWritten ? "필기 실전 모의고사 (50제)" : "실기 무작위 20문항";
        } else {
            // 선택된 연도 또는 회차 매칭 (공백 무시)
            const cleanTarget = String(year || '').replace(/\s+/g, '').replace('년도', '년');
            const matched = questions.filter(q => {
                const cleanSource = String(q.source || '').replace(/\s+/g, '').replace('년도', '년');
                return cleanSource.includes(cleanTarget);
            });
            // 회차 문제풀이 시에도 정형화 방지를 위해 문제 순서 무작위 셔플
            selectedQuestions = shuffleArray(matched);
            label = `${year} 기출 풀이`;
        }

        if (selectedQuestions.length === 0) {
            return res.json({ questions: [], quizLabel: label, sessionId: null });
        }

        // NET2_ 접두사 세션 ID 생성
        const sessionId = "NET2_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);

        const clientQuestions = selectedQuestions.map(q => {
            const copy = { ...q };
            delete copy.answer;
            delete copy.desc;
            return copy;
        });

        net2SessionStore.set(sessionId, {
            questions: selectedQuestions,
            quizLabel: label,
            createdAt: Date.now()
        });

        pruneOldSessions();

        res.json({
            sessionId: sessionId,
            quizLabel: label,
            questions: clientQuestions
        });
    } catch (e) {
        console.error("[NET2] 문제 출제 오류:", e);
        res.status(500).json({ error: "문제 데이터를 불러오는 중 오류가 발생했습니다." });
    }
}

/**
 * POST /check-answer
 * 단일 문제 즉시 정답/해설 확인
 */
function checkAnswer(req, res) {
    try {
        const { sessionId, questionId } = req.body;
        const session = net2SessionStore.get(sessionId);
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
        console.error("[NET2] 정답 확인 오류:", e);
        res.status(500).json({ error: "정답 확인 처리 중 오류가 발생했습니다." });
    }
}

/**
 * POST /submit
 * 답안 채점 및 결과 리포트 반환
 * - 필기: 50문항 기준, 1문항당 2점(100점 만점), 60점 이상 합격
 * - 실기: 1문항당 5점 배점, 부분점수 적용
 */
function submitQuiz(req, res) {
    try {
        const { sessionId, userAnswers } = req.body;
        const session = net2SessionStore.get(sessionId);
        if (!session) {
            return res.status(400).json({ error: "만료되었거나 유효하지 않은 시험 세션입니다." });
        }

        const questions = session.questions;
        const isWritten = (questions[0] && questions[0].type === 'written');
        let earnedScoreSum = 0;

        const reviewData = questions.map(q => {
            const userAns = (userAnswers && userAnswers[q.id]) ? String(userAnswers[q.id]).trim() : "";
            const realAns = String(q.answer || "").trim();
            let isRight = false;
            let earnedScore = 0;
            // 필기: 1문항당 2점 (50문항 × 2점 = 100점 만점)
            // 실기: 1문항당 5점
            let maxScore = isWritten ? 2 : 5;

            if (isWritten) {
                isRight = (userAns === realAns && userAns !== "");
                if (isRight) {
                    earnedScore = 2;
                }
                earnedScoreSum += earnedScore;
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
            // 필기: 문항당 2점 만점 대비 비율로 100점 환산 (50문항이 아닌 세션에서도 100점 만점)
            finalScore = totalQuestions > 0 ? Math.round((earnedScoreSum / (totalQuestions * 2)) * 100) : 0;
        } else {
            // 실기: 총점 대비 비율 환산
            const totalMaxScore = totalQuestions * 5;
            finalScore = totalMaxScore > 0 ? Math.round((earnedScoreSum / totalMaxScore) * 100 * 10) / 10 : 0;
        }

        const isPassed = (finalScore >= 60);

        res.json({
            score: finalScore,
            total: totalQuestions,
            isPassed: isPassed,
            reviewData: reviewData,
            quizLabel: session.quizLabel
        });
    } catch (e) {
        console.error("[NET2] 채점 제출 오류:", e);
        res.status(500).json({ error: "채점 처리 중 오류가 발생했습니다." });
    }
}

/**
 * GET /search?query=&type=&field=
 * 정답/문제/해설 키워드 검색
 */
function searchQuiz(req, res) {
    try {
        const query = (req.query.query || req.query.answer || '').trim().toLowerCase();
        const type = req.query.type || 'practical';
        const field = req.query.field || 'answer';

        if (!query) return res.json([]);

        const questions = loadQuestions(type);
        if (!questions) return res.json([]);

        const isWritten = (type === 'written');

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

        res.json(filtered);
    } catch (e) {
        console.error("[NET2] 검색 오류:", e);
        res.status(500).json({ error: "검색 중 오류가 발생했습니다." });
    }
}

module.exports = {
    getRounds,
    getNewQuiz,
    checkAnswer,
    submitQuiz,
    searchQuiz
};

