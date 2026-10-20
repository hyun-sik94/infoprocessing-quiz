const express = require('express');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./feedback.db');

// DB 테이블 구조 생성
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS feedbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        app_mode TEXT, 
        message TEXT, 
        reg_date TEXT,
        date_key TEXT,
        user_ip TEXT,
        fingerprint TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS banned_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_value TEXT UNIQUE,
        reason TEXT,
        created_at TEXT
    )`);
});

function loadJsonData(filePath) {
    try {
        const absolutePath = path.join(__dirname, filePath);
        if (fs.existsSync(absolutePath)) {
            const rawData = fs.readFileSync(absolutePath, 'utf8');
            return JSON.parse(rawData);
        } else {
            return [];
        }
    } catch (err) {
        return [];
    }
}

function sendSecurePayload(res, data) {
    const jsonStr = JSON.stringify(data);
    const encoded = Buffer.from(jsonStr, 'utf8').toString('base64');
    res.json({ payload: encoded });
}

function getSubjectNameServer(q) {
    if (q.type === 'written') {
        const id = q.id;
        if (id >= 2001 && id <= 2020) return "1과목: 소프트웨어 설계";
        if (id >= 2021 && id <= 2040) return "2과목: 소프트웨어 개발";
        if (id >= 2041 && id <= 2060) return "3과목: 데이터베이스 구축";
        if (id >= 2061 && id <= 2080) return "4과목: 프로그래밍 언어 활용";
        if (id >= 2081 && id <= 2100) return "5과목: 정보시스템 구축관리";
        return "필기 기출 공통";
    } else {
        return "실기 기출 종합";
    }
}

let practicalQuestionPool = loadJsonData('data/practical.json');
let writtenQuestionPool = loadJsonData('data/written.json');
let quizSessions = {};

app.post('/api/quiz/new', (req, res) => {
    const { year, bookmarkIds, solvedIds, examType, subject, targetQuestionId } = req.body;
    
    practicalQuestionPool = loadJsonData('data/practical.json');
    writtenQuestionPool = loadJsonData('data/written.json');
    
    let targetPool = (examType === 'written') ? writtenQuestionPool : practicalQuestionPool;
    let availableQuestions = [];
    let isSequentialMode = false;
    let quizLabel = "기출 문제풀이";

    if (targetQuestionId) {
        availableQuestions = targetPool.filter(q => q.id === targetQuestionId);
        quizLabel = "취약 문제 집중 풀이";
    } else if (subject) {
        availableQuestions = targetPool.filter(q => getSubjectNameServer(q) === subject);
        quizLabel = `과목별 풀이 (${subject})`;
    } else if (year === 'sequential') {
        availableQuestions = [...targetPool].sort((a, b) => a.id - b.id);
        isSequentialMode = true;
        quizLabel = "전체 순차 풀이";
    } else if (year === 'bookmark') {
        const ids = (bookmarkIds && bookmarkIds.ids) || [];
        const texts = (bookmarkIds && bookmarkIds.texts) || [];
        availableQuestions = targetPool.filter(q => ids.includes(q.id) || texts.includes(q.text));
        quizLabel = "즐겨찾기 풀이";
    } else if (year === 'cbt') {
        availableQuestions = [...targetPool];
        quizLabel = "실전 모의고사 (100제)";
    } else if (year === 'all') {
        availableQuestions = [...targetPool];
        quizLabel = "랜덤 모의고사 (30제)";
    } else {
        availableQuestions = targetPool.filter(q => q.source && q.source.includes(year + "년"));
        quizLabel = `${year}년도 기출 풀이`;
    }

    let selectedQuestions = [];
    if (isSequentialMode || targetQuestionId) {
        selectedQuestions = availableQuestions;
    } else {
        const unsolvedList = availableQuestions.filter(q => !solvedIds.includes(q.id));
        const solvedList = availableQuestions.filter(q => solvedIds.includes(q.id));
        const shuffledUnsolved = unsolvedList.sort(() => Math.random() - 0.5);
        const shuffledSolved = solvedList.sort(() => Math.random() - 0.5);
        const prioritizedCombined = [...shuffledUnsolved, ...shuffledSolved];
        let targetSize = 30;
        if (year === 'cbt') targetSize = 100;
        else if (subject) targetSize = prioritizedCombined.length;
        else if (year === 'all') targetSize = 30;
        else targetSize = Math.min(30, prioritizedCombined.length);

        selectedQuestions = prioritizedCombined.slice(0, targetSize);
    }

    const newSession = {
        id: Date.now(),
        year: year,
        type: examType || 'practical',
        quizLabel: quizLabel,
        fullQuestions: selectedQuestions,
        currentIndex: 0,
        userAnswers: {}
    };
    
    quizSessions[newSession.id] = newSession;

    const secureClientQuestions = selectedQuestions.map(q => {
        let inputCount = 1;
        if (q.inputCount) {
            inputCount = q.inputCount;
        } else if (q.answer && q.answer.includes(" / ")) {
            inputCount = q.answer.split(" / ").length;
        } else if (q.answer && q.answer.includes(",")) {
            inputCount = q.answer.split(",").length;
        }
        
        return {
            id: q.id,
            type: q.type || 'practical',
            source: q.source,
            text: q.text,
            view: q.view || null,
            choices: q.choices || null,
            image: q.image || null,
            inputCount: inputCount
        };
    });

    sendSecurePayload(res, { sessionId: newSession.id, quizLabel: quizLabel, questions: secureClientQuestions });
});

app.post('/api/quiz/check-answer', (req, res) => {
    const { sessionId, questionId } = req.body;
    const session = quizSessions[sessionId];
    let targetQuestion = null;
    if (session && session.fullQuestions) {
        targetQuestion = session.fullQuestions.find(q => q.id === questionId);
    }
    if (!targetQuestion) {
        targetQuestion = [...writtenQuestionPool, ...practicalQuestionPool].find(q => q.id === questionId);
    }
    if (!targetQuestion) {
        return res.status(404).json({ error: "해당 문제를 찾을 수 없습니다." });
    }

    sendSecurePayload(res, {
        answer: targetQuestion.answer,
        desc: targetQuestion.desc,
        choices: targetQuestion.choices || null
    });
});

app.post('/api/quiz/submit', (req, res) => {
    const { sessionId, userAnswers } = req.body;
    const session = quizSessions[sessionId];
    if (!session) {
        return res.status(400).json({ error: "존재하지 않거나 만료된 세션 회차 정보입니다." });
    }
    
    const currentSessionQuestions = session.fullQuestions;
    let totalEarnedPoints = 0;
    let subjectScores = {
        "1과목: 소프트웨어 설계": { correct: 0, total: 0, score: 0 },
        "2과목: 소프트웨어 개발": { correct: 0, total: 0, score: 0 },
        "3과목: 데이터베이스 구축": { correct: 0, total: 0, score: 0 },
        "4과목: 프로그래밍 언어 활용": { correct: 0, total: 0, score: 0 },
        "5과목: 정보시스템 구축관리": { correct: 0, total: 0, score: 0 }
    };

    const reviewData = currentSessionQuestions.map(q => {
        const userAnswer = (userAnswers[q.id] || "").trim();
        const realAnswer = q.answer; 
        let isRight = true;
        let questionEarnedPoints = 0;
        let questionMaxPoints = (q.type === 'written') ? 1 : 5;
        
        if (q.type === 'written') {
            if (userAnswer === realAnswer) {
                isRight = true;
                questionEarnedPoints = 1;
            } else {
                isRight = false;
                questionEarnedPoints = 0;
            }
            const subj = getSubjectNameServer(q);
            if (subjectScores[subj]) {
                subjectScores[subj].total++;
                if (isRight) subjectScores[subj].correct++;
            }
        } else {
            const slotDelimiter = realAnswer.includes(" / ") ? " / " : ",";
            const realSlots = realAnswer.split(slotDelimiter).map(s => s.trim());
            const userSlots = userAnswer.split(slotDelimiter).map(s => s.trim());
            
            let correctCount = 0;
            for (let i = 0; i < realSlots.length; i++) {
                const realSlotGroup = realSlots[i];
                const allowedAliases = realSlotGroup.split("|").map(a => a.trim().toLowerCase());
                const userSlotVal = (userSlots[i] || "").trim().toLowerCase();
                
                const isSlotMatch = allowedAliases.some(alias => {
                    return userSlotVal === alias || 
                           userSlotVal.replace(/\s+/g, '') === alias.replace(/\s+/g, '') ||
                           userSlotVal.replace(/[\.\s]/g, '') === alias.replace(/[\.\s]/g, '');
                });
                
                if (isSlotMatch) {
                    correctCount++;
                }
            }
            
            if (correctCount === realSlots.length) {
                isRight = true;
                questionEarnedPoints = 5;
            } else if (correctCount > 0) {
                isRight = false;
                questionEarnedPoints = Math.round((5 * (correctCount / realSlots.length)) * 10) / 10;
            } else {
                isRight = false;
                questionEarnedPoints = 0;
            }
        }
        
        totalEarnedPoints += questionEarnedPoints;
        return {
            id: q.id,
            source: q.source,
            text: q.text,
            view: q.view || null,
            choices: q.choices || null,
            type: q.type,
            userAnswer: userAnswer,
            realAnswer: realAnswer,
            desc: q.desc,
            image: q.image || null,
            isRight: isRight,
            earnedScore: questionEarnedPoints,
            maxScore: questionMaxPoints
        };
    });

    let finalScore = 0;
    let isGwarak = false;
    let gwarakSubjects = [];

    if (session.type === 'written') {
        finalScore = Math.round((totalEarnedPoints / currentSessionQuestions.length) * 100);
        Object.keys(subjectScores).forEach(subj => {
            const item = subjectScores[subj];
            if (item.total > 0) {
                item.score = Math.round((item.correct / item.total) * 100);
                if (item.score < 40) {
                    isGwarak = true;
                    gwarakSubjects.push(`${subj} (${item.score}점)`);
                }
            }
        });
    } else {
        finalScore = Math.round(totalEarnedPoints * 10) / 10;
    }

    let isPassed = false;
    if (session.type === 'written') {
        if (finalScore >= 60 && !isGwarak) isPassed = true;
    } else {
        if (finalScore >= 60) isPassed = true;
    }
    
    const quizLabel = session.quizLabel || "기출 문제풀이";
    delete quizSessions[sessionId];
    
    sendSecurePayload(res, { 
        score: finalScore, 
        isPassed: isPassed,
        isGwarak: isGwarak,
        gwarakSubjects: gwarakSubjects,
        subjectScores: subjectScores,
        quizLabel: quizLabel, 
        reviewData: reviewData 
    });
});

app.get('/api/quiz/search', (req, res) => {
    const query = (req.query.answer || '').trim();
    const examType = req.query.type || 'practical';
    if (!query) return sendSecurePayload(res, []);

    const targetPool = (examType === 'written') ? writtenQuestionPool : practicalQuestionPool;
    const lowerQuery = query.toLowerCase();
    const compactQuery = lowerQuery.replace(/\s+/g, '');

    const results = targetPool.filter(q => {
        if (!q.answer) return false;
        const lowerAnswer = q.answer.toLowerCase();
        const compactAnswer = lowerAnswer.replace(/\s+/g, '');
        return lowerAnswer.includes(lowerQuery) || compactAnswer.includes(compactQuery);
    });

    sendSecurePayload(res, results);
});

// 사용자 제보 등록 (하루 10회 제한 및 밴 체크)
app.post('/api/feedback', (req, res) => {
    const { appMode, message, fingerprint } = req.body;
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "127.0.0.1";
    const fp = fingerprint || "unknown_fp";
    const now = new Date();
    const dateKey = now.toISOString().split('T')[0];
    const regDate = now.toLocaleString('ko-KR');

    if (!message || message.trim() === "") {
        return res.status(400).json({ error: "제보 내용을 입력해 주세요." });
    }

    db.get("SELECT * FROM banned_users WHERE target_value = ? OR target_value = ?", [userIp, fp], (err, banned) => {
        if (err) return res.status(500).json({ error: "DB 조회 오류" });
        if (banned) {
            return res.status(403).json({ error: "차단된 사용자입니다. 더 이상 제보를 남길 수 없습니다." });
        }

        db.get(
            "SELECT COUNT(*) AS count FROM feedbacks WHERE (user_ip = ? OR fingerprint = ?) AND date_key = ?",
            [userIp, fp, dateKey],
            (err, row) => {
                if (err) return res.status(500).json({ error: "DB 검증 오류" });

                if (row && row.count >= 10) {
                    return res.status(429).json({ error: "하루에 최대 10개의 제보만 작성하실 수 있습니다. 내일 다시 시도해 주세요." });
                }

                const stmt = db.prepare("INSERT INTO feedbacks (app_mode, message, reg_date, date_key, user_ip, fingerprint) VALUES (?, ?, ?, ?, ?, ?)");
                stmt.run(appMode, message.trim(), regDate, dateKey, userIp, fp, function(err2) {
                    if (err2) {
                        return res.status(500).json({ error: "제보 저장에 실패했습니다." });
                    }
                    res.json({ success: true });
                });
                stmt.finalize();
            }
        );
    });
});

// 관리자 제보 목록 조회
app.get('/api/feedback/list', (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;

    db.get("SELECT COUNT(*) AS total FROM feedbacks", [], (err, countRow) => {
        if (err) return res.status(500).send("DB 오류가 발생했습니다.");
        
        const totalItems = countRow ? countRow.total : 0;
        const totalPages = Math.ceil(totalItems / limit) || 1;

        db.all("SELECT * FROM feedbacks ORDER BY id DESC LIMIT ? OFFSET ?", [limit, offset], (err, rows) => {
            if (err) return res.status(500).send("조회 오류가 발생했습니다.");

            db.all("SELECT target_value FROM banned_users", [], (err, bannedRows) => {
                const bannedSet = new Set(bannedRows ? bannedRows.map(b => b.target_value) : []);

                let itemsHtml = "";
                if (rows.length === 0) {
                    itemsHtml = `<div class="empty-msg">접수된 제보가 없습니다.</div>`;
                } else {
                    rows.forEach(row => {
                        const isIpBanned = bannedSet.has(row.user_ip);
                        const isFpBanned = bannedSet.has(row.fingerprint);
                        const isBanned = isIpBanned || isFpBanned;

                        itemsHtml += `
                            <div class="feedback-card ${isBanned ? 'banned-card' : ''}">
                                <div class="card-header">
                                    <span class="badge ${row.app_mode === 'written' ? 'written' : 'practical'}">
                                        ${row.app_mode === 'written' ? '필기' : '실기'}
                                    </span>
                                    <span class="reg-date">${row.reg_date}</span>
                                    ${isBanned ? '<span class="ban-tag">차단됨</span>' : ''}
                                </div>
                                <div class="card-message">${(row.message || '').replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
                                <div class="card-footer">
                                    <div class="user-info">
                                        <span>IP: <code>${row.user_ip || '알 수 없음'}</code></span>
                                        <span>Device FP: <code>${(row.fingerprint || '').substring(0, 12)}...</code></span>
                                    </div>
                                    <div class="actions">
                                        ${!isBanned ? `
                                            <button class="btn-ban" onclick="banUser('${row.user_ip}', '${row.fingerprint}')">사용자 차단(Ban)</button>
                                        ` : `
                                            <button class="btn-unban" onclick="unbanUser('${row.user_ip}', '${row.fingerprint}')">차단 해제</button>
                                        `}
                                    </div>
                                </div>
                            </div>
                        `;
                    });
                }

                let paginationHtml = `<div class="pagination">`;
                if (page > 1) {
                    paginationHtml += `<a href="/api/feedback/list?page=${page - 1}" class="page-btn">‹ 이전</a>`;
                }
                for (let i = 1; i <= totalPages; i++) {
                    paginationHtml += `<a href="/api/feedback/list?page=${i}" class="page-btn ${i === page ? 'active' : ''}">${i}</a>`;
                }
                if (page < totalPages) {
                    paginationHtml += `<a href="/api/feedback/list?page=${page + 1}" class="page-btn">다음 ›</a>`;
                }
                paginationHtml += `</div>`;

                const fullPageHtml = `
                <!DOCTYPE html>
                <html lang="ko">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>사용자 제보 관리 센터</title>
                    <style>
                        body { font-family: 'Malgun Gothic', sans-serif; background: #f4f6f9; margin: 0; padding: 20px; color: #333; }
                        .container { max-width: 800px; margin: 0 auto; }
                        .header-title { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #3182ce; padding-bottom: 12px; margin-bottom: 20px; }
                        .header-title h2 { margin: 0; color: #2d3748; }
                        .total-count { font-size: 14px; color: #718096; font-weight: bold; }
                        .feedback-card { background: #fff; border-radius: 10px; padding: 18px; margin-bottom: 15px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); border-left: 4px solid #3182ce; transition: all 0.2s; }
                        .feedback-card.banned-card { border-left-color: #e53e3e; background: #fff5f5; opacity: 0.8; }
                        .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
                        .badge { padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; color: #fff; }
                        .badge.written { background: #3182ce; }
                        .badge.practical { background: #38a169; }
                        .reg-date { font-size: 12px; color: #a0aec0; }
                        .ban-tag { font-size: 11px; font-weight: bold; color: #e53e3e; background: #fed7d7; padding: 2px 6px; border-radius: 4px; }
                        .card-message { font-size: 15px; line-height: 1.6; color: #2d3748; white-space: pre-wrap; margin-bottom: 12px; word-break: break-all; }
                        .card-footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #edf2f7; padding-top: 10px; font-size: 12px; color: #718096; }
                        .user-info code { background: #edf2f7; padding: 2px 5px; border-radius: 4px; color: #4a5568; }
                        .btn-ban { background: #e53e3e; color: #fff; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 12px; }
                        .btn-ban:hover { background: #c53030; }
                        .btn-unban { background: #718096; color: #fff; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 12px; }
                        .empty-msg { text-align: center; padding: 40px; color: #a0aec0; font-size: 15px; }
                        .pagination { display: flex; justify-content: center; gap: 6px; margin-top: 25px; }
                        .page-btn { padding: 8px 12px; border-radius: 6px; background: #fff; border: 1px solid #e2e8f0; color: #4a5568; text-decoration: none; font-size: 13px; font-weight: bold; }
                        .page-btn.active { background: #3182ce; color: #fff; border-color: #3182ce; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header-title">
                            <h2>💡 사용자 제보 관리 센터</h2>
                            <span class="total-count">총 ${totalItems}건 접수됨 (페이지 ${page}/${totalPages})</span>
                        </div>
                        ${itemsHtml}
                        ${paginationHtml}
                    </div>

                    <script>
                        function banUser(ip, fp) {
                            if (confirm('해당 사용자를 차단하시겠습니까? (이후 제보가 금지됩니다)')) {
                                fetch('/api/admin/ban', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ ip: ip, fp: fp, reason: '악성 제보 차단' })
                                }).then(res => res.json()).then(data => {
                                    alert('차단 처리되었습니다.');
                                    location.reload();
                                });
                            }
                        }

                        function unbanUser(ip, fp) {
                            if (confirm('차단을 해제하시겠습니까?')) {
                                fetch('/api/admin/unban', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ ip: ip, fp: fp })
                                }).then(res => res.json()).then(data => {
                                    alert('차단이 해제되었습니다.');
                                    location.reload();
                                });
                            }
                        }
                    </script>
                </body>
                </html>
                `;

                res.send(fullPageHtml);
            });
        });
    });
});

app.post('/api/admin/ban', (req, res) => {
    const { ip, fp, reason } = req.body;
    const now = new Date().toLocaleString('ko-KR');

    const stmt = db.prepare("INSERT OR IGNORE INTO banned_users (target_value, reason, created_at) VALUES (?, ?, ?)");
    stmt.run(ip, reason || "관리자 차단", now);
    stmt.run(fp, reason || "관리자 차단", now);
    stmt.finalize(err => {
        if (err) return res.status(500).json({ error: "차단 등록 정보 처리 실패" });
        res.json({ success: true });
    });
});

app.post('/api/admin/unban', (req, res) => {
    const { ip, fp } = req.body;
    db.run("DELETE FROM banned_users WHERE target_value = ? OR target_value = ?", [ip, fp], function(err) {
        if (err) return res.status(500).json({ error: "차단 해제 실패" });
        res.json({ success: true });
    });
});

app.listen(port, () => {
    console.log(`서버가 포트 ${port}에서 가동 중입니다.`);
});