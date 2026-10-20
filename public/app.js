let sessionQuizData = [];
let currentQuizIndex = 0;
let savedUserAnswers = {};
let activeSessionId = null;
let activeSessionYear = null;
let activeSessionType = null;
let activeQuizLabel = "";
let revealedAnswers = {};
let globalTabState = "all";

let currentAppMode = null; 
let activeInputRef = null;

let quizTimerInterval = null;
let remainingTimeSeconds = 0;

const BOOKMARK_KEY = "정처기_즐겨찾기_목록";
const HISTORY_KEY = "정처기_이력_목록";

function formatViewHtml(view) {
    if (!view) return "";

    // 1. 실제 행(<tr>)을 포함한 완성된 HTML 표이거나 pre/code 태그인 경우만 보호 처리
    if (/<table[^>]*>[\s\S]*<tr/i.test(view) || /<(pre|code|svg)[^>]*>/i.test(view)) {
        return view.replace(/<(\/?[SRAB]|보기)>/gi, '[$1]');
    }

    let text = escapeHtml(view);

    // 2. <보기>, [보기], (보기), [디자인 패턴 목록] 등 모든 보기 영역 완전 분리 (1차 방어)
    let bogiHtml = "";
    let bogiRegex = /(?:&lt;|<|\[|\()\s*(?:보기\vert{}디자인\s*패턴\s*목록\vert{}보기\s*목록)\s*(?:&gt;\vert{}>\vert{}\]\vert{}\))?:?([\s\S]*)/i;
    let bogiMatch = text.match(bogiRegex);

    if (bogiMatch) {
        let bogiRaw = bogiMatch[1].trim();
        text = text.substring(0, bogiMatch.index).trim();
        
        let bogiItems = bogiRaw.split(/[\n\|]|\s+\/\s+/).map(s => s.trim().replace(/^[•·\-\*]\s*/, '')).filter(s => s.length > 0);
        let chips = bogiItems.map(item => `<span class="view-bogi-chip">${item}</span>`).join('');

        if (chips) {
            bogiHtml = `
                <div class="view-bogi-container">
                    <div class="view-bogi-title">📋 [보기]</div>
                    <div class="view-bogi-chip-wrap">${chips}</div>
                </div>
            `;
        }
    }

    // 3. 본문 블록 분리 및 테이블/설명문 처리
    let blocks = text.split(/\n\s*\n/);
    let resultHtml = "";

    blocks.forEach(block => {
        let lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return;

        // 테이블명 또는 캡션 라인 감지 ([R], <회원> 등)
        let caption = "";
        let firstLine = lines[0];
        if (/^(&lt;|\[\vert{}<)[^>\]]+(&gt;|\]|>)(.*)$/.test(firstLine) && !firstLine.includes('|')) {
            caption = firstLine;
            lines = lines.slice(1);
        }

        // [2차 방어막] 만약 캡션에 '보기'가 포함되어 있다면 절대 표(Table)로 만들지 않고 보기 칩으로 즉시 변환
        if (/보기|목록/i.test(caption)) {
            let remainRaw = lines.join('\n');
            let bogiItems = remainRaw.split(/[\n\|]|\s+\/\s+/).map(s => s.trim().replace(/^[•·\-\*]\s*/, '')).filter(s => s.length > 0);
            let chips = bogiItems.map(item => `<span class="view-bogi-chip">${item}</span>`).join('');
            resultHtml += `
                <div class="view-bogi-container">
                    <div class="view-bogi-title">📋 [보기]</div>
                    <div class="view-bogi-chip-wrap">${chips}</div>
                </div>
            `;
            return;
        }

        if (caption) {
            resultHtml += `<div class="table-caption-line">${caption}</div>`;
        }
        if (lines.length === 0) return;

        let blockContent = lines.join('\n');

        // 소스코드 및 순서도는 표 변환 방지
        let isSourceCode = /int\s+Main|#include|public\s+class|class\s+\w+|void\s+\w+|return\s+\d+|while\s*\(|if\s*\(/i.test(blockContent);
        let isFlowChart = lines.some(l => l.includes('->') || l.includes('→')) && lines.some(l => l.includes('[') || l.includes('<'));

        if (isSourceCode || isFlowChart) {
            resultHtml += `<div class="code-flow-box">${lines.join('<br>')}</div>`;
            return;
        }

        // 실제 데이터베이스 표 판별
        let hasPipe = lines.some(l => l.includes('|'));

        if (hasPipe) {
            let rows = [];
            let currentRow = null;

            lines.forEach(line => {
                if (line.includes('|')) {
                    if (currentRow) rows.push(currentRow);
                    currentRow = line.split('|').map(c => c.trim());
                } else if (currentRow) {
                    currentRow[currentRow.length - 1] += '\n' + line;
                } else {
                    rows.push([line]);
                }
            });
            if (currentRow) rows.push(currentRow);

            resultHtml += buildHtmlTable(rows);
        } else {
            // 단일 열 테이블 감지
            let isSingleColTable = caption && lines.length >= 2 && lines.every(l => l.length <= 25 && !l.includes('.'));
            if (isSingleColTable) {
                let rows = lines.map(l => [l]);
                resultHtml += buildHtmlTable(rows);
            } else {
                resultHtml += `<div class="box-view" style="margin-bottom:8px;">${lines.map(l => `<p style="margin:4px 0;">${l}</p>`).join('')}</div>`;
            }
        }
    });

    return resultHtml + bogiHtml;
}

// 파이프 텍스트 라인들을 HTML 테이블 구조로 자동 변환하는 함수
function buildHtmlTable(rows) {
    if (!rows || rows.length === 0) return "";
    let html = '<div class="quiz-table-wrap"><table class="quiz-table">';

    let normalizedRows = rows.map(r => {
        if (Array.isArray(r)) return r;
        if (typeof r === 'string') return r.split('|').map(c => c.trim());
        return [String(r)];
    });

    if (normalizedRows.length === 0) return "";

    let firstRow = normalizedRows[0] || [];
    let firstCell = String(firstRow[0] || "");
    let isHeader = !/^(\(|\[|㉠|①|\d)/.test(firstCell) && normalizedRows.length > 1;

    normalizedRows.forEach((cols, idx) => {
        let isFirstRowHeader = (idx === 0 && isHeader);
        let tag = isFirstRowHeader ? 'th' : 'td';

        if (idx === 0 && isHeader) {
            html += '<thead><tr>';
        } else if (idx === 0 && !isHeader) {
            html += '<tbody><tr>';
        } else if (idx === 1 && isHeader) {
            html += '<tbody><tr>';
        } else {
            html += '<tr>';
        }

        cols.forEach((cell, cellIdx) => {
            let cellStr = String(cell || '');
            let cellContent = "";
            let subLines = cellStr.split('\n').map(s => s.trim()).filter(s => s.length > 0);

            if (subLines.length > 1 || (subLines.length === 1 && /^[•·\-\*]/.test(subLines[0]))) {
                cellContent = subLines.map(s => {
                    let clean = s.replace(/^[•·\-\*]\s*/, '');
                    return `<div class="cell-bullet-line">• ${clean}</div>`;
                }).join('');
            } else {
                cellContent = cellStr.replace(/\n/g, '<br>');
            }

            // 1열이 순수 괄호 빈칸 기호(( ① ), ( 1 ) 등)인지 판별
            let isPureSymbol = /^(\(\s*[①-⑮\dㄱ-ㅎa-zA-Z]?\s*\)|[①-⑮])$/.test(cellStr.trim());

            let alignClass = 'col-content';
            let inlineStyle = '';

            if (cellIdx === 0 && cols.length > 1) {
                if (isPureSymbol) {
                    alignClass = 'col-symbol';
                    inlineStyle = ' style="white-space: nowrap !important;"';
                    cellContent = cellContent.replace(/\s+/g, '&nbsp;');
                } else {
                    alignClass = 'col-center';
                }
            }

            html += `<${tag} class="${alignClass}"${inlineStyle}>${cellContent}</${tag}>`;
        });

        html += '</tr>';
        if (idx === 0 && isHeader) {
            html += '</thead>';
        }
    });

    html += '</tbody></table></div>';
    return html;
}

function formatQuestionView(rawText) {
    if (!rawText) return "";

    // 1. 불필요한 배점 표기 제거 (예: (5점), (10점))
    let cleanedText = rawText.replace(/\s*\(\s*\d+점\s*\)/g, "");

    // 2. 식별자 뒤 괄호는 제외하고, 순수 빈칸 및 기출용 원문자만 하이라이트 치환
    function highlightBlanks(str) {
        return escapeHtml(str).replace(/(?<![a-zA-Z0-9_])\(\s*([①-⑮㉠-㉾ㄱ-ㅎ]?)\s*\)/g, function(match, p1) {
            let inner = p1.trim() ? p1.trim() : "&nbsp;&nbsp;";
            return `<span class="q-blank">(&nbsp;${inner}&nbsp;)</span>`;
        });
    }

    // 3. 첫 번째 줄바꿈(\n)을 찾아 지시문과 본문 분리
    let firstBreakIndex = cleanedText.indexOf("\n");

    // 줄바꿈이 없는 단순 한 줄 질문인 경우
    if (firstBreakIndex === -1) {
        return `<div class="q-title-instruction" id="question-focus-target" tabindex="-1" style="outline: none;">${highlightBlanks(cleanedText)}</div>`;
    }

    let instruction = cleanedText.substring(0, firstBreakIndex).trim();
    let bodyText = cleanedText.substring(firstBreakIndex + 1).trim();

    // 4. 본문 라인별 처리 (불릿 기호 및 줄글 분리 + 빈칸 하이라이트)
    let bodyLines = bodyText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    let formattedBodyHtml = "";

    bodyLines.forEach(line => {
        let isBullet = line.startsWith("•") || line.startsWith("·") || line.startsWith("-") || line.startsWith("*");
        let textWithoutBullet = line.replace(/^[•·\-\*]\s*/, "");
        if (isBullet) {
            formattedBodyHtml += `<div class="q-desc-bullet-item">${highlightBlanks(textWithoutBullet)}</div>`;
        } else {
            formattedBodyHtml += `<p>${highlightBlanks(line)}</p>`;
        }
    });

    return `
        <div class="q-title-instruction" id="question-focus-target" tabindex="-1" style="outline: none;">${escapeHtml(instruction)}</div>
        <div class="q-desc-card-box">${formattedBodyHtml}</div>
    `;
}

function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function parseSecurePayload(data) {
    if (data && data.payload) {
        try {
            const decodedStr = decodeURIComponent(atob(data.payload).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));
            return JSON.parse(decodedStr);
        } catch (e) {
            console.error("복호화 에러:", e);
            return data;
        }
    }
    return data;
}

function getBookmarkedQuestions() {
    const data = localStorage.getItem(BOOKMARK_KEY);
    return data ? JSON.parse(data) : [];
}

function getHistoryLogs() {
    const data = localStorage.getItem(HISTORY_KEY);
    return data ? JSON.parse(data) : [];
}

function deleteHistoryLog(logId) {
    if (confirm("해당 풀이 기록을 삭제하시겠습니까?")) {
        let history = getHistoryLogs();
        history = history.filter(h => h.id !== logId);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        fetchHistoryLogs();
    }
}

function toggleBookmarkStatus(questionObj) {
    let bookmarks = getBookmarkedQuestions();
    const existsIdx = bookmarks.findIndex(b => b.text === questionObj.text);
    
    if (existsIdx > -1) {
        bookmarks.splice(existsIdx, 1);
    } else {
        bookmarks.push(questionObj);
    }
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bookmarks));
    
    if (activeSessionId) {
        renderSingleQuestion();
    } else if (globalTabState === "my") {
        renderMyBookmarksTab();
    }
}

function isQuestionBookmarked(text) {
    const bookmarks = getBookmarkedQuestions();
    return bookmarks.some(b => b.text === text);
}

function updateBottomTabUI() {
    document.querySelectorAll(".tab-unit").forEach(t => t.classList.remove("active"));
    const switchTextElem = document.getElementById("tab-switch-text");
    
    if (globalTabState === 'all') {
        const tabAll = document.getElementById("tab-all");
        if(tabAll) tabAll.classList.add("active");
    } else if (globalTabState === 'my') {
        const tabMy = document.getElementById("tab-my");
        if(tabMy) tabMy.classList.add("active");
    } else if (globalTabState === 'analysis') {
        const tabAnalysis = document.getElementById("tab-analysis");
        if(tabAnalysis) tabAnalysis.classList.add("active");
    }

    if (currentAppMode === 'practical') {
        if(switchTextElem) switchTextElem.innerText = "필기 전환";
    } else if (currentAppMode === 'written') {
        if(switchTextElem) switchTextElem.innerText = "실기 전환";
    }
}

function switchMainTab(tabType) {
    globalTabState = tabType;
    updateBottomTabUI();
    
    if (tabType === 'all') {
        if (activeSessionId) {
            renderSingleQuestion();
        } else {
            loadMainDashboard();
        }
    } else if (tabType === 'my') {
        if (activeSessionId) {
            const confirmMsg = (activeSessionYear === 'sequential') 
                ? "진행 상황이 저장되었습니다. 즐겨찾기 메뉴로 이동하시겠습니까?" 
                : "현재 진행 중인 모의고사를 중단하고 즐겨찾기 메뉴로 이동하시겠습니까?";
            if (confirm(confirmMsg)) {
                clearInterval(quizTimerInterval);
                activeSessionId = null;
                activeSessionYear = null;
                activeSessionType = null;
                history.replaceState(null, '', window.location.pathname);
                renderMyBookmarksTab();
            } else {
                globalTabState = 'all';
                updateBottomTabUI();
            }
        } else {
            history.replaceState(null, '', window.location.pathname);
            renderMyBookmarksTab();
        }
    } else if (tabType === 'analysis') {
        if (activeSessionId) {
            const confirmMsg = (activeSessionYear === 'sequential') 
                ? "진행 상황이 저장되었습니다. 성과 분석 메뉴로 이동하시겠습니까?" 
                : "현재 진행 중인 모의고사를 중단하고 성과 분석 메뉴로 이동하시겠습니까?";
            if (confirm(confirmMsg)) {
                clearInterval(quizTimerInterval);
                activeSessionId = null;
                activeSessionYear = null;
                activeSessionType = null;
                history.replaceState(null, '', window.location.pathname);
                renderAnalysisTab();
            } else {
                globalTabState = 'all';
                updateBottomTabUI();
            }
        } else {
            history.replaceState(null, '', window.location.pathname);
            renderAnalysisTab();
        }
    }
}

function switchAppMode() {
    if (activeSessionId) {
        if (!confirm("현재 진행 중인 시험 내역이 초기화됩니다. 모드를 전환하시겠습니까?")) {
            return;
        }
    }
    clearInterval(quizTimerInterval);
    activeSessionId = null;
    activeSessionYear = null;
    activeSessionType = null;
    history.replaceState(null, '', window.location.pathname);
    
    currentAppMode = (currentAppMode === 'practical') ? 'written' : 'practical';
    globalTabState = 'all';
    
    updateBottomTabUI();
    loadMainDashboard();
}

function setAppMode(mode) {
    currentAppMode = mode;
    globalTabState = 'all';
    updateBottomTabUI();
    loadMainDashboard();
}

function loadModeSelectionScreen() {
    clearInterval(quizTimerInterval);
    history.replaceState(null, '', window.location.pathname);
    document.querySelector(".tab-fixed-bar").style.display = "none";
    document.querySelector(".header").style.display = "none";
    
    const container = document.getElementById("view-renderer");
    container.innerHTML = `
        <div class="mode-select-container">
            <div class="hero-badge">2026 합격 케어 패스</div>
            <h1 class="hero-title">정보처리기사<br>스마트 기출 풀이</h1>
            <p class="hero-sub">목표하시는 시험 단계를 선택하고<br>맞춤형 학습을 시작하세요.</p>
            
            <div class="mode-card-group">
                <div class="modern-mode-card written" onclick="setAppMode('written')">
                    <div class="card-icon-wrapper written-bg">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.2 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                    </div>
                    <div class="card-content">
                        <div class="card-tag written-tag">객관식 5과목</div>
                        <div class="card-title">필기 모드</div>
                        <div class="card-desc">100문항 CBT 실전 테스트 & 과목별 기출</div>
                    </div>
                    <div class="card-arrow">➔</div>
                </div>
                
                <div class="modern-mode-card practical" onclick="setAppMode('practical')">
                    <div class="card-icon-wrapper practical-bg">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                    </div>
                    <div class="card-content">
                        <div class="card-tag practical-tag">주관식 / 단답형</div>
                        <div class="card-title">실기 모드</div>
                        <div class="card-desc">부분점수 채점 & 핵심 용어 검색</div>
                    </div>
                    <div class="card-arrow">➔</div>
                </div>
            </div>
        </div>
    `;
}

function getSubjectName(q) {
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

function startSubjectQuiz(subjectName) {
    triggerNewQuizSession('subject', null, subjectName);
}

function startSingleQuestionQuiz(qId) {
    triggerNewQuizSession('target', null, null, qId);
}

function renderAnalysisTab() {
    const isWritten = (currentAppMode === 'written');
    document.getElementById("header-center-title").innerText = isWritten ? "필기 성과 분석" : "실기 성과 분석";
    const container = document.getElementById("view-renderer");
    
    const logs = getHistoryLogs().filter(log => log.type === currentAppMode);
    
    if (logs.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding-top:60px; color:#95a5a6;">
                <div style="font-size:45px; margin-bottom:15px;">📊</div>
                <p style="font-size:14px;">저장된 풀이 기록이 없습니다.<br>문제 풀이 후 성과 분석을 확인해 보세요!</p>
            </div>
        `;
        return;
    }

    let totalExamCount = logs.length;
    let totalScoreSum = 0;
    let totalQuestionSum = 0;
    let passCount = 0;
    
    let subjectStatsMap = {};

    logs.forEach(log => {
        totalScoreSum += log.score;
        totalQuestionSum += log.total;
        if ((log.score / log.total) >= 0.6) {
            passCount++;
        }

        if (log.questions) {
            log.questions.forEach(q => {
                const subject = getSubjectName(q);
                if (!subjectStatsMap[subject]) {
                    subjectStatsMap[subject] = { total: 0, correct: 0, wrongQuestions: {} };
                }
                
                subjectStatsMap[subject].total++;
                if (q.isRight) {
                    subjectStatsMap[subject].correct++;
                } else {
                    const key = q.source + " - " + q.text;
                    if (!subjectStatsMap[subject].wrongQuestions[key]) {
                        subjectStatsMap[subject].wrongQuestions[key] = { id: q.id, count: 0, text: q.text, source: q.source };
                    }
                    subjectStatsMap[subject].wrongQuestions[key].count++;
                }
            });
        }
    });

    let avgPercent = Math.round((totalScoreSum / totalQuestionSum) * 100);
    let passPercent = Math.round((passCount / totalExamCount) * 100);

    let subjectCardsHtml = "";
    Object.keys(subjectStatsMap).forEach(subjectName => {
        const stat = subjectStatsMap[subjectName];
        const subjectPercent = Math.round((stat.correct / stat.total) * 100);
        
        let wrongList = Object.values(stat.wrongQuestions).sort((a, b) => b.count - a.count).slice(0, 3);
        
        let wrongItemsHtml = "";
        if (wrongList.length > 0) {
            wrongItemsHtml = wrongList.map(w => `
                <div style="font-size:12px; color:#c0392b; background:#fff; padding:8px 10px; border-radius:6px; margin-top:6px; border:1px solid #fadbd8; text-align:left; cursor:pointer;" onclick="startSingleQuestionQuiz(${w.id})">
                    <div style="font-weight:bold; display:flex; justify-content:space-between;">
                        <span>[${w.source}] - ${w.count}회 오답</span>
                        <span style="color:#3498db; text-decoration:underline;">[문제풀기 ➔]</span>
                    </div>
                    <div style="color:#555; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px;">${escapeHtml(w.text)}</div>
                </div>
            `).join("");
        } else {
            wrongItemsHtml = `<div style="font-size:12px; color:#2ecc71; margin-top:6px;">틀린 문제가 없습니다. 우수한 성적입니다!</div>`;
        }

        subjectCardsHtml += `
            <div class="log-box-card" style="border-top-color: #3498db; margin-bottom:15px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-weight:bold; color:#2c3e50; font-size:15px;">${subjectName}</span>
                    <span style="font-weight:bold; color:${subjectPercent >= 60 ? '#2ecc71' : '#e74c3c'}; font-size:15px;">${subjectPercent}%</span>
                </div>
                <div style="width:100%; background:#edf2f7; height:8px; border-radius:4px; overflow:hidden; margin-bottom:10px;">
                    <div style="width:${subjectPercent}%; background:${subjectPercent >= 60 ? '#2ecc71' : '#e74c3c'}; height:100%;"></div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:12px; color:#7f8c8d;">총 ${stat.total}문항 중 ${stat.correct}문항 맞춤</span>
                    <button class="nav-control-btn" style="padding:6px 10px; font-size:12px; background-color:#3498db; width:auto;" onclick="startSubjectQuiz('${subjectName}')">이 과목만 풀기</button>
                </div>
                <div style="font-size:13px; font-weight:bold; color:#34495e; margin-top:10px; text-align:left;">해당 과목 자주 틀리는 취약 문제 (클릭 시 풀기)</div>
                ${wrongItemsHtml}
            </div>
        `;
    });

    let html = `
        <div style="padding-top:10px;">
            <div style="background:#f8f9fa; border:1px solid #e2e8f0; border-radius:12px; padding:15px; margin-bottom:20px; text-align:center;">
                <div style="font-weight:bold; color:#2c3e50; font-size:16px; margin-bottom:12px;">🏆 전체 누적 응시 리포트</div>
                <div style="display:flex; justify-content:space-around; background:#fff; padding:12px; border-radius:8px; border:1px solid #edf2f7;">
                    <div>
                        <div style="font-size:11px; color:#7f8c8d;">총 응시 횟수</div>
                        <div style="font-size:18px; font-weight:bold; color:#2c3e50;">${totalExamCount}회</div>
                    </div>
                    <div>
                        <div style="font-size:11px; color:#7f8c8d;">평균 정답률</div>
                        <div style="font-size:18px; font-weight:bold; color:#3498db;">${avgPercent}%</div>
                    </div>
                    <div>
                        <div style="font-size:11px; color:#7f8c8d;">합격률</div>
                        <div style="font-size:18px; font-weight:bold; color:#2ecc71;">${passPercent}%</div>
                    </div>
                </div>
            </div>

            <h4 style="color:#34495e; border-bottom:2px solid #34495e; padding-bottom:5px; margin-bottom:15px;">과목별 정답률 및 취약 문제 분석</h4>
            ${subjectCardsHtml}
        </div>
    `;

    container.innerHTML = html;
    container.scrollTop = 0;
}

function loadMainDashboard() {
    clearInterval(quizTimerInterval);
    history.replaceState(null, '', window.location.pathname);

    if (!currentAppMode) {
        loadModeSelectionScreen();
        return;
    }

    document.querySelector(".tab-fixed-bar").style.display = "flex";
    document.querySelector(".header").style.display = "flex";
    
    activeSessionId = null;
    activeSessionYear = null;
    activeSessionType = null;
    activeInputRef = null;
    
    const isWritten = (currentAppMode === 'written');
    document.getElementById("header-center-title").innerText = isWritten ? "필기 기출 메인" : "실기 기출 메인";
    const container = document.getElementById("view-renderer");

    let dashboardHtml = `
        <div style="text-align:center; padding-top:15px;">
            <div style="font-size:45px; margin-bottom:5px;">${isWritten ? '📝' : '💻'}</div>
            <h3 style="color:#2c3e50; margin-bottom:5px;">정처기 ${isWritten ? '필기' : '실기'} 기출 풀이</h3>
            <p style="font-size:13px; color:#7f8c8d; line-height:1.6; margin-bottom:15px; padding:0 15px;">
                원하는 학습 모드와 회차를 선택해 주세요.
            </p>
    `;

    if (isWritten) {
        dashboardHtml += `
            <div style="margin-bottom: 15px; padding: 0 30px;">
                <select id="quiz-year-select" style="width:100%; padding:14px; font-size:15px; border:2px solid #3498db; border-radius:8px; outline:none; color:#2c3e50; font-weight:bold; background-color:#ebf5ff;">
                    <option value="cbt">필기 실전 모의고사 (랜덤 100제)</option>
                    <option value="2025">2025년도 필기 기출</option>
                    <option value="2024">2024년도 필기 기출</option>
                    <option value="sequential">필기 전체 문항 순서대로 풀기</option>
                </select>
            </div>
            <button class="nav-control-btn" style="width:85%; background-color:#3498db; margin-bottom: 20px;" onclick="triggerNewQuizSession()">
                선택 회차 문제풀기 시작
            </button>
        `;
    } else {
        dashboardHtml += `
            <div style="margin-bottom: 15px; padding: 0 30px;">
                <select id="quiz-year-select" style="width:100%; padding:14px; font-size:15px; border:2px solid #2ecc71; border-radius:8px; outline:none; color:#2c3e50; font-weight:bold; background-color:#eafaf1;">
                    <option value="all">실기 무작위 30문항 풀기</option>
                    <option value="2026">2026년도 실기 기출</option>
                    <option value="2025">2025년도 실기 기출</option>
                    <option value="2024">2024년도 실기 기출</option>
                    <option value="2023">2023년도 실기 기출</option>
                    <option value="2022">2022년도 실기 기출</option>
                    <option value="2021">2021년도 실기 기출</option>
                    <option value="sequential">실기 전체 문항 순서대로 풀기</option>
                </select>
            </div>
            <button class="nav-control-btn" style="width:85%; background-color:#2ecc71; margin-bottom: 20px;" onclick="triggerNewQuizSession()">
                선택 회차 문제풀기 시작
            </button>
        `;
    }

    dashboardHtml += `
            <div style="border-top: 1px dashed #e2e8f0; padding-top: 20px; margin: 0 30px 20px 30px; text-align: left;">
                <span class="input-label-text" style="margin-bottom: 6px;">정답으로 문제 찾기</span>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <input type="text" id="search-answer-input" class="input-answer" placeholder="기억나는 정답 용어 입력" style="margin-bottom: 0; flex: 1;" onkeypress="handleSearchKeyPress(event)">
                    <button class="nav-control-btn" style="padding: 0 16px; width: auto; flex-shrink: 0; background-color: #34495e; height: 48px; border-radius: 8px;" onclick="searchQuestionByAnswer()">검색</button>
                </div>
            </div>
        </div>
        
        <div id="dashboard-dynamic-area">
            <div onclick="toggleHistoryAreaVisibility()" style="border-left:4px solid #34495e; padding-left:8px; font-weight:bold; color:#34495e; font-size:15px; margin-bottom:15px; margin-top: 10px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
                <span>회차별 풀이 이력 및 오답확인</span>
                <span id="history-toggle-arrow" style="font-size: 12px; margin-right: 10px; color: #7f8c8d;">▼</span>
            </div>
            <div id="history-ajax-area">이력을 조회하는 중입니다...</div>
        </div>
    `;
    
    container.innerHTML = dashboardHtml;
    fetchHistoryLogs();
}

function toggleHistoryAreaVisibility() {
    const historyArea = document.getElementById("history-ajax-area");
    const arrowElement = document.getElementById("history-toggle-arrow");
    
    if (!historyArea || !arrowElement) return;
    
    if (historyArea.style.display === "none") {
        historyArea.style.display = "block";
        arrowElement.innerText = "▼";
    } else {
        historyArea.style.display = "none";
        arrowElement.innerText = "▲";
    }
}

async function searchQuestionByAnswer() {
    const query = document.getElementById("search-answer-input").value.trim();
    if (!query) {
        alert("검색할 정답 키워드를 입력해 주세요.");
        return;
    }
    
    try {
        const res = await fetch(`/api/quiz/search?answer=${encodeURIComponent(query)}&type=${currentAppMode}`);
        const rawData = await res.json();
        const data = parseSecurePayload(rawData);
        renderSearchResults(data, query);
    } catch(e) {
        console.error("검색 오류:", e);
        alert(`검색 연동 중 에러가 발생했습니다.\n에러 원인: ${e.message}`);
    }
}

function handleSearchKeyPress(e) {
    if (e.key === 'Enter') {
        searchQuestionByAnswer();
    }
}

function renderSearchResults(results, query) {
    const dynamicArea = document.getElementById("dashboard-dynamic-area");
    if (!dynamicArea) return;
    
    let html = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 20px; margin-bottom: 15px; border-left: 4px solid #3498db; padding-left: 8px;">
            <span style="font-weight: bold; color: #2c3e50; font-size: 15px;">'${query}' 검색 결과 (총 ${results.length}건)</span>
            <span style="font-size: 12px; color: #3498db; cursor: pointer; text-decoration: underline; font-weight: bold;" onclick="loadMainDashboard()">이력 목록으로 돌아가기</span>
        </div>
    `;
    
    if (results.length === 0) {
        html += `<div style="text-align: center; color: #95a5a6; font-size: 14px; padding: 40px 0;">해당 정답을 가진 기출문제를 찾을 수 없습니다.</div>`;
    } else {
        results.forEach((r, idx) => {
            const isBookmarked = isQuestionBookmarked(r.text);
            const starChar = isBookmarked ? "★" : "☆";
            const modeText = r.type === 'written' ? '[필기]' : '[실기]';
            let cleanDesc = r.desc ? r.desc.replace(/\[cite:\s*[\d,\s]+\]/gi, "").trim() : "";
            
            html += `
                <div class="log-box-card" style="border-top-color: #3498db;">
                    <span class="bookmark-toggle-btn" style="position: absolute; top: 12px; right: 15px;" onclick="toggleBookmarkStatusFromSearch(${idx})">${starChar}</span>
                    <div class="source-tag">${modeText} ${r.source}</div>
                    <div class="question-title" style="font-size: 14px; padding-right: 25px; white-space: pre-wrap; line-height: 1.6; word-break: break-all; letter-spacing: -0.3px;">문제: ${escapeHtml(r.text)}</div>
                    ${r.image ? `<div style="text-align:center; margin-bottom:12px;"><img src="${r.image}" class="question-img" alt="기출 이미지"></div>` : ''}
                    ${r.view ? `<div class="view-content-wrapper">${formatViewHtml(r.view)}</div>` : ''}
                    <div style="font-size: 13px; color: #27ae60; font-weight: bold; margin-top: 5px;">출제 정답: ${r.answer}</div>
                    <div style="margin-top: 8px; font-size: 12px; color: #555; background: #f8f9fa; padding: 10px; border-radius: 6px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; border: 1px solid #e2e8f0;">${cleanDesc}</div>
                </div>
            `;
        });
    }
    
    window.searchCurrentResults = results;
    dynamicArea.innerHTML = html;
}

function toggleBookmarkStatusFromSearch(index) {
    if (window.searchCurrentResults && window.searchCurrentResults[index]) {
        const q = window.searchCurrentResults[index];
        toggleBookmarkStatus({
            id: q.id,
            type: q.type,
            source: q.source,
            text: q.text,
            view: q.view,
            choices: q.choices || null,
            answer: q.answer,
            desc: q.desc,
            image: q.image || null
        });
        const query = document.getElementById("search-answer-input").value.trim();
        renderSearchResults(window.searchCurrentResults, query);
    }
}

function renderMyBookmarksTab() {
    const isWritten = (currentAppMode === 'written');
    document.getElementById("header-center-title").innerText = isWritten ? "필기 즐겨찾기" : "실기 즐겨찾기";
    const container = document.getElementById("view-renderer");
    
    const bookmarks = getBookmarkedQuestions().filter(b => b.type === currentAppMode);
    
    if (bookmarks.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding-top:60px; color:#95a5a6;">
                <div style="font-size:45px; margin-bottom:15px;">⭐</div>
                <p style="font-size:14px;">현재 모드에 보관된 즐겨찾기가 없습니다.</p>
            </div>
        `;
        return;
    }
    
    const bookmarkIds = bookmarks.map(b => b.id).filter(id => id !== undefined);
    const bookmarkTexts = bookmarks.map(b => b.text);
    let startButtonHtml = "";
    if (bookmarkIds.length > 0) {
        startButtonHtml = `
            <button class="nav-control-btn" style="width:100%; background-color:${isWritten ? '#3498db' : '#2ecc71'}; margin-bottom: 20px;" onclick="startBookmarkQuiz()">
                해당 항목 모의고사 가동 (${bookmarkIds.length}문항)
            </button>
        `;
    }
    
    let html = `
        ${startButtonHtml}
        <p style="font-size:13px; color:#7f8c8d; margin-bottom:15px;">보관된 항목 총 ${bookmarks.length}개</p>
    `;
    
    bookmarks.forEach((b, idx) => {
        const modeText = b.type === 'written' ? '[필기]' : '[실기]';
        let cleanDesc = b.desc ? b.desc.replace(/\[cite:\s*[\d,\s]+\]/gi, "").trim() : "";

        html += `
            <div class="log-box-card" style="border-top-color: #f1c40f;">
                <span class="bookmark-toggle-btn" style="position:absolute; top:12px; right:15px;" onclick="removeBookmarkFromTab(${idx})">★</span>
                <div class="source-tag">${modeText} ${b.source}</div>
                <div class="question-title" style="font-size:14px; padding-right:25px; white-space: pre-wrap; line-height: 1.6; word-break: break-all; letter-spacing: -0.3px;">${escapeHtml(b.text)}</div>
                ${b.image ? `<div style="text-align:center; margin-bottom:12px;"><img src="${b.image}" class="question-img" alt="기출 이미지"></div>` : ''}
                ${b.view ? `<div class="view-content-wrapper">${formatViewHtml(b.view)}</div>` : ''}
                <div style="font-size:13px; color:#27ae60; font-weight:bold; margin-top:5px;">정답 용어: ${escapeHtml(b.answer)}</div>
                <div style="margin-top: 8px; font-size: 12px; color: #555; background: #f8f9fa; padding: 10px; border-radius: 6px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; border: 1px solid #e2e8f0;">${cleanDesc}</div>
            </div>
        `;
    });
    container.innerHTML = html;
    container.scrollTop = 0;
}

function removeBookmarkFromTab(index) {
    const bookmarks = getBookmarkedQuestions().filter(b => b.type === currentAppMode);
    if (bookmarks[index]) {
        toggleBookmarkStatus(bookmarks[index]);
    }
}

function startBookmarkQuiz() {
    const bookmarks = getBookmarkedQuestions().filter(b => b.type === currentAppMode);
    const bookmarkIds = bookmarks.map(b => b.id).filter(id => id !== undefined);
    const bookmarkTexts = bookmarks.map(b => b.text);
    
    if (bookmarks.length === 0) {
        alert("즐겨찾기가 없습니다.");
        return;
    }
    
    triggerNewQuizSession('bookmark', { ids: bookmarkIds, texts: bookmarkTexts });
}

function fetchHistoryLogs() {
    const area = document.getElementById("history-ajax-area");
    const data = getHistoryLogs().filter(log => log.type === currentAppMode);
    
    if (data.length === 0) {
        area.innerHTML = "<p style='color:#999; font-size:13px;'>저장된 완료 기록이 없습니다.</p>";
        return;
    }
    
    window.historyLogQuestions = window.historyLogQuestions || {};
    let html = "";
    [...data].reverse().forEach(s => {
        const targetQuestions = s.questions || s.wrongs || [];
        window.historyLogQuestions[s.id] = targetQuestions;
        const quizLabel = s.quizLabel || "기출 문제풀이";

        html += `
            <div class="log-box-card" style="position:relative;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <span style="display:inline-block; padding:3px 8px; font-size:11px; font-weight:bold; border-radius:10px; background-color:#ebf5ff; color:#2980b9; margin-bottom:4px;">${quizLabel}</span>
                        <div style="font-size:11px; color:#95a5a6;">풀이 시점: ${s.date}</div>
                    </div>
                    <button class="header-btn" style="background:#e74c3c; border:none; padding:4px 10px; font-size:11px; color:#fff;" onclick="deleteHistoryLog(${s.id})">삭제</button>
                </div>
                <div style="font-size:15px; font-weight:bold; margin:6px 0; color:#2c3e50;">최종 점수: ${s.score} / ${s.total} 문항</div>
                <div style="font-size:13px; color:#e74c3c; font-weight:bold; margin-bottom:10px;">틀린 문제 수: ${s.wrongCount}개</div>
                <button class="nav-control-btn" style="padding:6px; font-size:12px; background-color:#3498db;" onclick="toggleHistoryWrongList(${s.id})">
                    상세 문항 확인하기
                </button>
                <div id="wrong-container-${s.id}" style="display:none; margin-top:5px;">
                    ${targetQuestions.map((w, idx) => {
                        const isRight = w.isRight !== undefined ? w.isRight : false;
                        const isBookmarked = isQuestionBookmarked(w.text);
                        const starChar = isBookmarked ? "★" : "☆";
                        const modeText = w.type === 'written' ? '[필기]' : '[실기]';
                        let cleanDesc = w.desc ? w.desc.replace(/\[cite:\s*[\d,\s]+\]/gi, "").trim() : "";

                        return `
                            <div class="history-wrong-item" style="border-left: 4px solid ${isRight ? '#2ecc71' : '#e74c3c'}; padding-left: 10px; margin-bottom: 12px; position: relative;">
                                <span class="bookmark-toggle-btn" style="position: absolute; top: 0; right: 5px; cursor: pointer; font-size: 18px;" onclick="toggleBookmarkFromHistory(${s.id}, ${idx}, this)">${starChar}</span>
                                <div style="font-weight:bold; color:${isRight ? '#2ecc71' : '#c0392b'}; margin-bottom:3px;">${modeText} ${w.source} [${isRight ? '정답' : '오답'}]</div>
                                <div style="font-weight:bold; color:#333; margin-bottom:4px; white-space: pre-wrap; line-height: 1.5; word-break: break-all;">문제: ${escapeHtml(w.text)}</div>${w.image ? `<div style="text-align:center; margin-top:8px; margin-bottom:8px;"><img src="${w.image}" class="question-img" alt="기출 이미지"></div>` : ''}
                                ${w.view ? `<div class="view-content-wrapper">${formatViewHtml(w.view)}</div>` : ''}
                                <div style="font-size:13px; margin:2px 0;">작성 답안: <span style="font-weight:bold; color:${isRight ? '#27ae60':'#c0392b'}">${escapeHtml(w.userAnswer) || "미입력"}</span></div>
                                <div style="font-size:13px; margin:2px 0; color:#27ae60; font-weight:bold;">정답 용어: ${escapeHtml(w.realAnswer || w.answer)}</div>
                                <div style="margin-top: 8px; font-size: 12px; color: #555; background: #f8f9fa; padding: 10px; border-radius: 6px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; border: 1px solid #e2e8f0;">${cleanDesc}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    });
    area.innerHTML = html;
}

function toggleBookmarkFromHistory(sessionId, idx, element) {
    if (window.historyLogQuestions && window.historyLogQuestions[sessionId] && window.historyLogQuestions[sessionId][idx]) {
        const q = window.historyLogQuestions[sessionId][idx];
        toggleBookmarkStatus({
            id: q.id,
            type: q.type,
            source: q.source,
            text: q.text,
            view: q.view,
            choices: q.choices || null,
            answer: q.realAnswer || q.answer,
            desc: q.desc,
            image: q.image || null
        });
        const isBookmarked = isQuestionBookmarked(q.text);
        element.innerText = isBookmarked ? "★" : "☆";
    }
}

function toggleBookmarkFromReview(idx, element) {
    if (window.currentReviewQuestions && window.currentReviewQuestions[idx]) {
        const q = window.currentReviewQuestions[idx];
        toggleBookmarkStatus({
            id: q.id,
            type: q.type,
            source: q.source,
            text: q.text,
            view: q.view,
            choices: q.choices || null,
            answer: q.realAnswer || q.answer,
            desc: q.desc,
            image: q.image || null
        });
        const isBookmarked = isQuestionBookmarked(q.text);
        element.innerText = isBookmarked ? "★" : "☆";
    }
}

function toggleHistoryWrongList(id) {
    const area = document.getElementById("wrong-container-" + id);
    area.style.display = area.style.display === "none" ? "block" : "none";
}

function startQuizTimer(isNewSession) {
    clearInterval(quizTimerInterval);
    if (isNewSession) {
        if (currentAppMode === 'written') {
            remainingTimeSeconds = 150 * 60; 
        } else {
            remainingTimeSeconds = sessionQuizData.length * 90; 
        }
    }
    updateTimerDisplay();

    quizTimerInterval = setInterval(() => {
        remainingTimeSeconds--;
        if (remainingTimeSeconds <= 0) {
            clearInterval(quizTimerInterval);
            alert("제한 시간이 종료되었습니다. 작성된 곳까지 자동으로 답안이 제출됩니다.");
            submitQuizAnswers();
        } else {
            updateTimerDisplay();
        }
    }, 1000);
}

function updateTimerDisplay() {
    const timerElem = document.getElementById("quiz-timer-display");
    if (timerElem) {
        const minutes = Math.floor(remainingTimeSeconds / 60);
        const seconds = remainingTimeSeconds % 60;
        timerElem.innerText = `남은 시간: ${minutes}분 ${seconds}초`;
    }
}

window.openQuestionNavModal = function() {
    const modal = document.getElementById("q-nav-modal");
    if(modal) {
        modal.style.display = "flex";
    }
};

window.closeQuestionNavModal = function(event) {
    const modal = document.getElementById("q-nav-modal");
    if(modal) {
        modal.style.display = "none";
    }
};

window.jumpToQuestion = function(index) {
    currentQuizIndex = index;
    closeQuestionNavModal(); 
    renderSingleQuestion();
};

async function triggerNewQuizSession(customYear, customIds, customSubject, customTargetId) {
    let selectedYear = customYear;
    let bookmarkIds = customIds || [];
    
    if (!selectedYear) {
        const selectElem = document.getElementById("quiz-year-select");
        selectedYear = selectElem ? selectElem.value : "all";
    }

    // 순차 풀이 이어풀기 기록 검사 및 복원 준비 (지문은 서버 최신본 유지)
    let resumeState = null;
    if (selectedYear === 'sequential' && localStorage.getItem("정처기_순차풀이_중간저장")) {
        const savedState = JSON.parse(localStorage.getItem("정처기_순차풀이_중간저장"));
        if (savedState.activeSessionType === currentAppMode) {
            const shouldResume = customTargetId ? true : confirm("이전에 멈춤 기록이 존재합니다. 이어서 풀이하시겠습니까? (취소 시 1번부터 시작)");
            if (shouldResume) {
                resumeState = savedState;
            } else {
                localStorage.removeItem("정처기_순차풀이_중간저장");
            }
        } else {
            localStorage.removeItem("정처기_순차풀이_중간저장");
        }
    }
    
    const historyLogs = getHistoryLogs();
    let allSolvedIds = [];
    historyLogs.forEach(log => {
        if (log.solvedIds) {
            allSolvedIds = allSolvedIds.concat(log.solvedIds);
        }
    });
    allSolvedIds = [...new Set(allSolvedIds)];
    
    try {
        // 문제 목록은 항상 서버 API를 통해 최신 practical.json 기준으로 호출
        const res = await fetch('/api/quiz/new', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                year: selectedYear, 
                bookmarkIds: bookmarkIds,
                solvedIds: allSolvedIds,
                examType: currentAppMode,
                subject: customSubject || null,
                targetQuestionId: customTargetId || null
            })
        });
        const rawData = await res.json();
        const data = parseSecurePayload(rawData);
        
        if (!data.questions || data.questions.length === 0) {
            alert("현재 해당 조건에 등록된 문제 데이터가 없습니다.");
            return;
        }
        
        activeSessionId = data.sessionId;
        activeSessionYear = selectedYear;
        activeSessionType = currentAppMode;
        activeQuizLabel = data.quizLabel || "기출 문제풀이";
        sessionQuizData = data.questions;

        // 이어풀기인 경우 위치와 이전 작성 답안만 복원
        if (resumeState) {
            currentQuizIndex = Math.min(resumeState.currentQuizIndex || 0, sessionQuizData.length - 1);
            savedUserAnswers = resumeState.savedUserAnswers || {};
            remainingTimeSeconds = resumeState.remainingTimeSeconds || (currentAppMode === 'written' ? 150 * 60 : sessionQuizData.length * 90);
            
            if (customTargetId) {
                const foundIdx = sessionQuizData.findIndex(item => item.id === parseInt(customTargetId, 10));
                if (foundIdx !== -1) {
                    currentQuizIndex = foundIdx;
                }
            }

            revealedAnswers = {};
            activeInputRef = null;
            startQuizTimer(false);
        } else {
            if (customTargetId && selectedYear === 'sequential') {
                const foundIdx = sessionQuizData.findIndex(item => item.id === parseInt(customTargetId, 10));
                currentQuizIndex = (foundIdx !== -1) ? foundIdx : 0;
            } else {
                currentQuizIndex = 0;
            }
            savedUserAnswers = {};
            revealedAnswers = {};
            activeInputRef = null;
            startQuizTimer(true);
        }
        
        renderSingleQuestion();
    } catch(e) {
        console.error("퀴즈 세션 생성 오류:", e);
        alert(`데이터 처리 중 오류가 발생했습니다.\n상세 에러: ${e.message}`);
    }
}

function extractChoices(q) {
    if (q.type === 'written') return ""; 
    
    let choicesText = "";
    
    if (q.view) {
        const headerKeywords = ["[디자인 패턴 목록]", "[보기 목록]", "[보기]", "<보기>", "[목록]"];
        for (const h of headerKeywords) {
            let idx = q.view.lastIndexOf(h);
            if (idx !== -1) {
                choicesText = q.view.substring(idx + h.length).trim();
                break;
            }
        }
    }
    
    if (!choicesText && q.text) {
        let lastBracket = q.text.lastIndexOf("[보기]");
        let lastAngle = q.text.lastIndexOf("<보기>");
        if (lastBracket !== -1 && q.text.substring(lastBracket).match(/^[보기](에서|를|의|참조|\s*찾아)/)) lastBracket = -1;
        if (lastAngle !== -1 && q.text.substring(lastAngle).match(/^<보기>(에서|를|의|참조|\s*찾아)/)) lastAngle = -1;
        let idx = Math.max(lastBracket, lastAngle);
        if (idx !== -1) {
            choicesText = q.text.substring(idx + 4).trim();
        }
    }
    
    if (!choicesText && q.view) {
        const trimmedView = q.view.trim();
        const isTableOrCode = /<table|<div|#include|int\s+main|public\s+class|class\s+\w+|<\w+.*>/i.test(trimmedView);
        
        if (!isTableOrCode) {
            const lines = trimmedView.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            const hasItemMarkers = lines.length > 0 && lines.every(line => /^[㉠-㉾①-⑮•\-\*]|^\([0-9a-zA-Zㄱ-ㅎ㉠-㉾①-⑮]+\)|^[0-9a-zA-Zㄱ-ㅎ]\s*[\.\,\)\:]/i.test(line));
            
            // 단순 설명문 내 콜론(:)이나 쉼표(,)는 단어 목록으로 오인하지 않도록 파이프(|) 중심 판별
            const hasChoiceKeywords = q.text.includes("보기") || q.text.includes("골라") || q.text.includes("아래에서") || q.text.includes("찾아");
            const isWordList = hasChoiceKeywords && trimmedView.includes("|") &&
                               !lines.some(line => line.includes("SELECT") || line.includes("FROM") || line.includes("UPDATE"));

            if (hasItemMarkers || isWordList) {
                choicesText = trimmedView;
            }
        }
    }
    
    if (!choicesText) return "";
    
    let lines = choicesText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    let cleanLines = [];
    
    for (let line of lines) {
        if (/^\[.*\]$/.test(line) || line.includes("패턴 목록") || line.includes("보기 목록")) {
            continue;
        }

        if (line.includes("기입") || line.includes("선택하여") || line.includes("쓰시오") || 
            line.includes("입력란") || line.includes("번 칸") || line.includes("양식에") || 
            line.includes("보기 중에서") || line.includes("설명식") || line.includes("따라")) {
            continue;
        }
        
        if (line.includes("패턴:") || line.includes("패턴 :")) {
            const parts = line.split(":");
            if (parts.length > 1) {
                line = parts[1].trim();
            }
        }
        cleanLines.push(line);
    }
    
    let rawItems = [];
    for (let line of cleanLines) {
        let lineItems = [];
        if (line.includes("|")) {
            lineItems = line.split("|");
        } else if (line.includes(",")) {
            lineItems = line.split(",");
        } else if (/\s+\/\s+/.test(line)) {
            lineItems = line.split(/\s+\/\s+/);
        } else if (/\s{2,}|\t/.test(line)) {
            lineItems = line.split(/\s{2,}|\t/);
        } else {
            lineItems = [line];
        }
        rawItems = rawItems.concat(lineItems);
    }
    
    let cleanItems = [];
    for (let item of rawItems) {
        let text = item.trim();
        if (!text) continue;

        if (/^[\|\,\/\•\-\*\·\s]+$/.test(text)) continue;

        text = text.replace(/^[•\-\*\·\s]+/, '');
        text = text.replace(/^[㉠-㉾①-⑮]/, '');
        text = text.replace(/^[0-9a-zA-Zㄱ-ㅎ]\s*[\.\,\)\:]\s*/, '');
        text = text.replace(/^\([0-9a-zA-Zㄱ-ㅎ㉠-㉾①-⑮]+\)\s*/, '');
        text = text.trim();

        // 15자를 넘는 긴 설명문, 문장 기호(~, :), 괄호 기호 등이 포함된 본문 텍스트는 버튼에서 제외
        if (!text || text.length > 15 || text.includes("~") || text.includes(":") || text.includes("영역") ||
            text === "생성 패턴" || text === "구조 패턴" || text === "행위 패턴" ||
            text.includes("패턴 목록") || text.includes("목록]") || text.endsWith("]") ||
            text.includes("번 칸:") || text.includes("입력란:")) {
            continue;
        }

        cleanItems.push(text);
    }
    
    cleanItems = [...new Set(cleanItems)];
    if (cleanItems.length === 0) return "";
    
    let html = `
        <div class="choices-guide-wrap" style="margin-top: 10px; margin-bottom: 6px;">
            <div style="font-size: 11.5px; font-weight: bold; color: #2980b9; margin-bottom: 4px; display: flex; align-items: center; gap: 4px;">
                [빠른 정답 입력]
            </div>
            <div class="choices-container" style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: flex-start;"> 
        `;
    
    cleanItems.forEach(item => {
        const safeClickVal = item.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        html += `
            <button type="button" class="choice-badge" style="padding: 6px 12px; background: #ffffff; border: 1px solid #3498db; border-radius: 20px; font-size: 13px; color: #2980b9; cursor: pointer; font-weight: bold; outline: none; transition: background 0.2s;" 
                onclick="handleChoiceClick('${safeClickVal}')" 
                onfocus="this.style.background='#e8f0fe';" 
                onblur="this.style.background='#ffffff';">
                ${escapeHtml(item)}
            </button>
        `;
    });
    
    html += '</div></div>';
    return html;
}

function handleChoiceClick(val) {
    let q = sessionQuizData[currentQuizIndex];
    if (q.type === 'written') return;
    
    if (!activeInputRef || !document.body.contains(activeInputRef)) {
        if (q.inputCount > 1) {
            for (let i = 0; i < q.inputCount; i++) {
                let input = document.querySelector(`.multi-input-${q.id}[data-index="${i}"]`);
                if (input && !input.value.trim()) {
                    activeInputRef = input;
                    break;
                }
            }
            if (!activeInputRef) {
                activeInputRef = document.querySelector(`.multi-input-${q.id}[data-index="0"]`);
            }
        } else {
            activeInputRef = document.getElementById("active-single-input");
        }
    }
    
    if (activeInputRef) {
        activeInputRef.value = val;
        activeInputRef.dispatchEvent(new Event('input', { bubbles: true }));
        activeInputRef.focus();
    }
}

window.selectWrittenAnswer = function(qId, choiceNum) {
    savedUserAnswers[qId] = choiceNum;
    renderSingleQuestion(); 
};

function focusInitialField(q) {
    // 문제 최상단 지시문으로 포커스 이동 (가상 키보드 팝업 방지 및 지문 우선 노출)
    const questionTarget = document.getElementById("question-focus-target");
    if (questionTarget) {
        questionTarget.focus();
    }

    // [빠른 정답 입력] 터치 시 바로 들어갈 수 있도록 참조만 백그라운드에 보관
    if (q.type !== 'written') {
        if (q.inputCount > 1) {
            activeInputRef = document.querySelector(`.multi-input-${q.id}[data-index="0"]`);
        } else {
            activeInputRef = document.getElementById("active-single-input");
        }
    }
}

function renderSingleQuestion() {
    const q = sessionQuizData[currentQuizIndex];
    if (!q) return;

    // 현재 문제 ID와 모드를 URL 파라미터에 실시간 반영 (새로고침 시 해당 문제 유지)
    if (activeSessionYear === 'sequential') {
        history.replaceState(null, '', `?mode=${currentAppMode}&year=sequential&id=${q.id}`);
    } else {
        history.replaceState(null, '', `?mode=${currentAppMode}&id=${q.id}`);
    }

    const modeLabel = q.type === 'written' ? '객관식 필기 모드' : '주관식 실기 모드';
    document.getElementById("header-center-title").innerText = modeLabel;
    const container = document.getElementById("view-renderer");
    
    const isBookmarked = isQuestionBookmarked(q.text);
    const starChar = isBookmarked ? "★" : "☆";
    
    let delimiter = (q.answer && q.answer.includes(" / ")) ? " / " : ",";
    
    // 순차 풀이 시 지문은 제외하고 답안과 인덱스만 가볍게 저장
    if (activeSessionYear === 'sequential') {
        const saveState = {
            activeSessionYear: activeSessionYear,
            activeSessionType: activeSessionType,
            currentQuizIndex: currentQuizIndex,
            savedUserAnswers: savedUserAnswers,
            remainingTimeSeconds: remainingTimeSeconds 
        };
        localStorage.setItem("정처기_순차풀이_중간저장", JSON.stringify(saveState));
    }
    
    let inputHtml = '<div class="input-block-wrapper">';
    if (q.type === 'written') {
        const cachedValue = savedUserAnswers[q.id] || "";
        inputHtml += '<div class="cbt-choices-container">';
        if (q.choices && q.choices.length > 0) {
            q.choices.forEach((choiceText, idx) => {
                const choiceNum = String(idx + 1);
                const isSelected = (cachedValue === choiceNum) ? 'selected' : '';
                inputHtml += `<button type="button" class="cbt-choice-btn ${isSelected}" onclick="window.selectWrittenAnswer(${q.id}, '${choiceNum}')">`;
                inputHtml += `<span class="cbt-choice-num">${choiceNum}</span> <span class="cbt-choice-text">${escapeHtml(choiceText)}</span>`;
                inputHtml += `</button>`;
            });
        }
        inputHtml += '</div>';
    } else if (q.inputCount > 1) {
        const cachedValue = savedUserAnswers[q.id] || "";
        const cachedAnswers = cachedValue.split(delimiter).map(s => s.trim());
        for (let i = 0; i < q.inputCount; i++) {
            const currentVal = cachedAnswers[i] || "";
            inputHtml += `
                <div style="margin-bottom: 10px;">
                    <span class="input-label-text">${i + 1}번 입력란</span>
                    <input type="text" class="input-answer multi-input-${q.id}" data-index="${i}" placeholder="${i + 1}번 정답 입력" value="${currentVal}" onfocus="activeInputRef = this" oninput="synchronizeMultiAnswer(${q.id}, ${q.inputCount}, '${delimiter}')" onkeypress="handleInputNavigation(event, ${i}, ${q.inputCount})">
                </div>
            `;
        }
    } else {
        const cachedValue = savedUserAnswers[q.id] || "";
        inputHtml += `
            <span class="input-label-text">정답 입력란</span>
            <input type="text" id="active-single-input" class="input-answer" placeholder="여기에 주관식 정답을 기입하세요" value="${cachedValue}" onfocus="activeInputRef = this" oninput="synchronizeSingleAnswer(${q.id}, this.value)" onkeypress="handleSingleKeyPress(event)">
        `;
    }
    inputHtml += '</div>';
    
    let choicesHtml = extractChoices(q);

    let modalHtml = `
        <div id="q-nav-modal" class="q-nav-modal-overlay" onclick="closeQuestionNavModal(event)">
            <div class="q-nav-modal-content" onclick="event.stopPropagation()">
                <div class="q-nav-modal-header">
                    전체 문항 이동
                    <span class="q-nav-modal-close" onclick="closeQuestionNavModal()">✕</span>
                </div>
                <div class="q-nav-modal-body">
    `;
    
    sessionQuizData.forEach((question, idx) => {
        const cachedAns = savedUserAnswers[question.id] || "";
        const isAnswered = cachedAns.replace(/,/g, '').replace(/\//g, '').trim() !== "";
        const isCurrent = idx === currentQuizIndex ? 'current' : '';
        const statusHtml = isAnswered ? `<span class="q-nav-status answered">풀이 완료</span>` : `<span class="q-nav-status">미풀이</span>`;
        
        modalHtml += `
            <div class="q-nav-list-btn ${isCurrent}" onclick="jumpToQuestion(${idx})">
                <span>${idx + 1}번 문항</span>
                ${statusHtml}
            </div>
        `;
    });

    modalHtml += `
                </div>
            </div>
        </div>
    `;
    
    let html = `
        <div class="step-panel-header">
            <div class="step-label clickable" onclick="openQuestionNavModal()">문항 이동: ${currentQuizIndex + 1} / ${sessionQuizData.length} ▼</div>
            <div id="quiz-timer-display" class="timer-display"></div>
            <span class="bookmark-toggle-btn" id="bookmark-icon" onclick="handleBookmarkClick()">${starChar}</span>
        </div>
        <div class="source-tag">${q.source}</div>
        
        ${formatQuestionView(q.text)}
        
        ${q.image ? `<div style="text-align:center; margin-bottom:15px;"><img src="${q.image}" class="question-img" alt="기출 이미지"></div>` : ''}
        ${q.view ? `<div class="view-content-wrapper">${formatViewHtml(q.view)}</div>` : ''}
        
        ${choicesHtml}
        ${inputHtml}
        
        <div id="instant-reveal-area"></div>

        <div class="action-toggle-card" id="main-action-trigger-card" onclick="toggleInstantFeedbackReveal(${q.id})">
            정답 확인
        </div>

        <div class="nav-btn-group">
            <button class="nav-control-btn" style="background-color:#7f8c8d;" onclick="moveStep(-1)" ${currentQuizIndex === 0 ? 'disabled' : ''}>← Prev</button>
            <button class="nav-control-btn" onclick="moveStep(1)">
                ${currentQuizIndex === sessionQuizData.length - 1 ? '최종 채점 및 제출' : 'Next →'}
            </button>
        </div>
        
        ${modalHtml}
    `;
    
    container.innerHTML = html;
    container.scrollTop = 0;
    
    updateTimerDisplay();
    
    if (revealedAnswers[q.id]) {
        showAnswerBoxInline(q, revealedAnswers[q.id]);
    }

    focusInitialField(q);
}

async function toggleInstantFeedbackReveal(qId) {
    const q = sessionQuizData[currentQuizIndex];
    
    if (revealedAnswers[qId]) {
        const panelArea = document.getElementById("instant-reveal-area");
        if (panelArea && panelArea.innerHTML !== "") {
            hideAnswerBoxInline();
        } else {
            showAnswerBoxInline(q, revealedAnswers[qId]);
        }
    } else {
        try {
            const res = await fetch('/api/quiz/check-answer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: activeSessionId, questionId: qId })
            });
            const rawData = await res.json();
            const data = parseSecurePayload(rawData);
            
            if (data.error) {
                alert(`정답 조회 실패: ${data.error}`);
                return;
            }
            
            revealedAnswers[qId] = data; 
            showAnswerBoxInline(q, data);
        } catch(e) {
            console.error("정답 조회 오류:", e);
            alert(`정답을 불러오는 중 오류가 발생했습니다.\n상세: ${e.message}`);
        }
    }
}

function showAnswerBoxInline(q, answerData) {
    const panelArea = document.getElementById("instant-reveal-area");
    if (!panelArea) return;
    
    const data = answerData || revealedAnswers[q.id];
    if (!data) return;
    
    let answerDisplay = data.answer;
    if (q.type === 'written' && data.choices) {
        const ansIdx = parseInt(data.answer, 10) - 1;
        if (data.choices[ansIdx]) {
            answerDisplay = `${data.answer}번. ${escapeHtml(data.choices[ansIdx])}`;
        }
    }

    let cleanDesc = data.desc ? data.desc.replace(/\[cite:\s*[\d,\s]+\]/gi, "").trim() : "";

    panelArea.innerHTML = `
        <div class="instant-feedback-panel">
            <div style="font-weight:bold; color:#15803d; margin-bottom:8px; font-size:15px;">💡 출제 정답: ${answerDisplay}</div>
            <div style="font-size:14px; color:#166534; line-height: 1.6; word-break: keep-all;">${cleanDesc}</div>
        </div>
    `;
    
    const actionCard = document.getElementById("main-action-trigger-card");
    if (actionCard) {
        actionCard.innerText = "확인 완료";
        actionCard.style.backgroundColor = "#16a34a";
    }

    setTimeout(() => {
        if (actionCard) {
            actionCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, 50);
}

function hideAnswerBoxInline() {
    const panelArea = document.getElementById("instant-reveal-area");
    if (panelArea) {
        panelArea.innerHTML = "";
    }
    
    const actionCard = document.getElementById("main-action-trigger-card");
    if (actionCard) {
        actionCard.innerText = "정답 확인";
        actionCard.style.backgroundColor = "#3fa0a0";
    }
}

function synchronizeSingleAnswer(qId, val) {
    savedUserAnswers[qId] = val;
}

function synchronizeMultiAnswer(qId, count, delimiter) {
    const answers = [];
    for (let i = 0; i < count; i++) {
        const inputElement = document.querySelector(`.multi-input-${qId}[data-index="${i}"]`);
        answers.push(inputElement ? inputElement.value.trim() : "");
    }
    const joinStr = delimiter === " / " ? " / " : ", ";
    savedUserAnswers[qId] = answers.join(joinStr);
}

function handleInputNavigation(e, index, total) {
    if (e.key === 'Enter') {
        if (index < total - 1) {
            const nextInput = document.querySelector(`.multi-input-${sessionQuizData[currentQuizIndex].id}[data-index="${index + 1}"]`);
            if (nextInput) nextInput.focus();
        } else {
            moveStep(1);
        }
    }
}

function handleSingleKeyPress(e) {
    if (e.key === 'Enter') {
        moveStep(1);
    }
}

function handleBookmarkClick() {
    const q = sessionQuizData[currentQuizIndex];
    if (q) {
        toggleBookmarkStatus(q);
    }
}

function moveStep(dir) {
    if (dir === 1 && currentQuizIndex === sessionQuizData.length - 1) {
        submitQuizAnswers();
        return;
    }
    currentQuizIndex += dir;
    renderSingleQuestion();
}

async function submitQuizAnswers() {
    try {
        const res = await fetch('/api/quiz/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: activeSessionId, userAnswers: savedUserAnswers })
        });
        const rawData = await res.json();
        const result = parseSecurePayload(rawData);
        
        if (!res.ok || result.error || !result.reviewData) {
            alert(`채점 처리 중 오류가 발생했습니다.\n상세: ${result.error || "정상적인 데이터를 수신하지 못했습니다."}`);
            return;
        }
        
        localStorage.removeItem("정처기_순차풀이_중간저장");
        
        saveHistoryToLocal(result);
        renderReviewResult(result);
    } catch (e) {
        console.error("제출 오류:", e);
        alert(`서버 연결 및 제출 중 오류가 발생했습니다.\n상세: ${e.message}`);
    }
}

function saveHistoryToLocal(result) {
    if (!result || !result.reviewData) return;

    const history = getHistoryLogs();
    const questions = result.reviewData.map(r => ({
        id: r.id,
        type: r.type,
        source: r.source,
        text: r.text,
        view: r.view,
        choices: r.choices || null,
        userAnswer: r.userAnswer,
        realAnswer: r.realAnswer,
        desc: r.desc,
        image: r.image || null,
        isRight: r.isRight
    }));
    
    const currentSolvedIds = result.reviewData.map(r => r.id);

    const newLog = {
        id: Date.now(),
        date: new Date().toLocaleString('ko-KR'),
        type: activeSessionType,
        quizLabel: result.quizLabel || activeQuizLabel || "기출 문제풀이",
        score: result.score,
        total: result.total,
        wrongCount: result.reviewData.filter(r => !r.isRight).length,
        questions: questions,
        solvedIds: currentSolvedIds
    };
    
    history.push(newLog);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function renderReviewResult(result) {
    clearInterval(quizTimerInterval);
    history.replaceState(null, '', window.location.pathname);
    document.getElementById("header-center-title").innerText = "채점 분석 리포트";
    const view = document.getElementById("view-renderer");
    activeSessionId = null;
    activeSessionYear = null;
    activeSessionType = null;
    activeInputRef = null;
    
    window.currentReviewQuestions = result.reviewData;
    
    const finalScore = result.score;
    const isPassed = result.isPassed;
    const isGwarak = result.isGwarak;
    const gwarakSubjects = result.gwarakSubjects || [];

    let resultBannerHtml = "";
    if (isPassed) {
        resultBannerHtml = `
            <div class="pass-celebration-card">
                <div class="sparkle-group">
                    <span class="sparkle-star">✨</span>
                    <span class="sparkle-star" style="animation-delay: 0.3s;">⭐</span>
                    <span class="sparkle-star" style="animation-delay: 0.6s;">✨</span>
                </div>
                
                <div class="cute-mascot">
                    <svg viewBox="0 0 100 100" width="100%" height="100%">
                        <circle cx="50" cy="55" r="35" fill="#f1c40f" />
                        <circle cx="33" cy="58" r="6" fill="#e74c3c" opacity="0.4" />
                        <circle cx="67" cy="58" r="6" fill="#e74c3c" opacity="0.4" />
                        <circle cx="38" cy="50" r="4" fill="#2c3e50" />
                        <circle cx="62" cy="50" r="4" fill="#2c3e50" />
                        <polygon points="45,55 55,55 50,63" fill="#e67e22" />
                        <polygon points="35,28 42,15 50,25 58,15 65,28" fill="#f39c12" />
                        <circle cx="42" cy="13" r="2" fill="#e74c3c" />
                        <circle cx="50" cy="23" r="2" fill="#3498db" />
                        <circle cx="58" cy="13" r="2" fill="#e74c3c" />
                    </svg>
                </div>

                <h2 style="margin: 0 0 8px 0; font-size: 24px; font-weight: bold;">축하합니다! 합격입니다!</h2>
                <p style="margin: 0; font-size: 15px; font-weight: bold;">
                    최종 점수: ${finalScore}점 / 100점 만점
                </p>
                <p style="margin: 4px 0 0 0; font-size: 12px; opacity: 0.9;">
                    (합격 기준: 60점 이상 및 과락 미발생)
                </p>
            </div>
        `;
    } else {
        let failReasonText = "평균 점수 60점 미달";
        if (isGwarak) {
            failReasonText = `과락 발생 [${gwarakSubjects.join(", ")}]`;
        }

        resultBannerHtml = `
            <div style="background: linear-gradient(135deg, #e74c3c, #c0392b); color: #ffffff; padding: 25px 20px; border-radius: 12px; margin-bottom: 20px; text-align: center; box-shadow: 0 4px 15px rgba(231,76,60,0.3);">
                <div style="font-size: 45px; margin-bottom: 5px;">💪</div>
                <h2 style="margin: 0 0 5px 0; font-size: 24px;">아쉽습니다! 불합격입니다</h2>
                <p style="margin: 0; font-size: 16px; font-weight: bold;">
                    최종 점수: ${finalScore}점 / 100점 만점
                </p>
                <p style="margin: 6px 0 0 0; font-size: 12px; background: rgba(0,0,0,0.2); padding: 6px; border-radius: 6px;">
                    불합격 사유: ${failReasonText}
                </p>
            </div>
        `;
    }
    
    let html = `
        <div style="padding: 10px 0;">
            ${resultBannerHtml}
            <button class="nav-control-btn" style="width:100%; margin-bottom:20px;" onclick="loadMainDashboard()">대시보드 메인으로 복귀</button>
        </div>
        <h4 style="color:#34495e; border-bottom:2px solid #34495e; padding-bottom:5px; margin-bottom:15px;">문항별 상세 리뷰</h4>
    `;
    
    result.reviewData.forEach((r, idx) => {
        const isBookmarked = isQuestionBookmarked(r.text);
        const starChar = isBookmarked ? "★" : "☆";
        const modeText = r.type === 'written' ? '[필기]' : '[실기]';
        
        let answerDisplay = escapeHtml(r.realAnswer);
        if (r.type === 'written' && r.choices) {
            const ansIdx = parseInt(r.realAnswer, 10) - 1;
            if (r.choices[ansIdx]) {
                answerDisplay = `${r.realAnswer}번. ${escapeHtml(r.choices[ansIdx])}`;
            }
        }

        let scoreBadge = "";
        if (r.type === 'practical') {
            scoreBadge = `<span style="font-size:12px; font-weight:bold; color:${r.earnedScore > 0 ? '#27ae60' : '#e74c3c'}; float:right;">획득: ${r.earnedScore}점 / ${r.maxScore}점</span>`;
        }

        let cleanDesc = r.desc ? r.desc.replace(/\[cite:\s*[\d,\s]+\]/gi, "").trim() : "";

        html += `
            <div class="log-box-card" style="border-top-color: ${r.isRight ? '#2ecc71' : (r.earnedScore > 0 ? '#f39c12' : '#e74c3c')}; position: relative;">
                <span class="bookmark-toggle-btn" style="position: absolute; top: 12px; right: 15px; cursor: pointer; font-size: 18px;" onclick="toggleBookmarkFromReview(${idx}, this)">${starChar}</span>
                <div class="source-tag">${idx + 1}번 | ${modeText} 출처: ${r.source} [${r.isRight ? 'PASS' : (r.earnedScore > 0 ? 'PARTIAL' : 'FAIL')}] ${scoreBadge}</div>
                <div class="question-title" style="font-size:14px; margin-bottom:8px; white-space: pre-wrap; line-height: 1.5; word-break: break-all;">문제: ${escapeHtml(r.text)}</div>
                ${r.image ? `<div style="text-align:center; margin-bottom:12px;"><img src="${r.image}" class="question-img" alt="기출 이미지"></div>` : ''}
                ${r.view ? `<div class="view-content-wrapper">${formatViewHtml(r.view)}</div>` : ''}
                <div style="font-size:13px; margin:2px 0;">작성 답안: <span style="font-weight:bold; color:${r.isRight ? '#27ae60' : (r.earnedScore > 0 ? '#d35400' : '#c0392b')}">${escapeHtml(r.userAnswer) || "미입력"}</span></div>
                <div style="font-size:13px; margin:2px 0; color:#27ae60; font-weight:bold;">정답 용어: ${answerDisplay}</div>
                <div style="margin-top:8px; font-size:12px; color:#555; background:#f8f9fa; padding:10px; border-radius:6px; line-height:1.5; white-space: pre-wrap; word-break: break-all; border: 1px solid #e2e8f0;">${cleanDesc}</div>
            </div>
        `;
    });
    
    view.innerHTML = html;
    view.scrollTop = 0;
}

function exitToDashboard() {
    if (activeSessionId) {
        const confirmMessage = (activeSessionYear === 'sequential')
            ? "진행 상황이 저장되었습니다. 메인 화면으로 돌아가시겠습니까?"
            : "시험을 중단하고 메인 화면으로 돌아가시겠습니까?";

        if (confirm(confirmMessage)) {
            loadMainDashboard();
        }
    } else {
        loadMainDashboard();
    }
}

function generateDeviceFingerprint() {
    const nav = window.navigator;
    const screen = window.screen;
    const rawStr = [
        nav.userAgent,
        nav.language,
        screen.colorDepth,
        screen.width + "x" + screen.height,
        new Date().getTimezoneOffset()
    ].join("||");

    let hash = 0;
    for (let i = 0; i < rawStr.length; i++) {
        const char = rawStr.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0;
    }
    return "FP_" + Math.abs(hash).toString(16);
}

window.openFeedbackModal = function() {
    const message = prompt("기출문제 오류나 앱 기능 개선에 대한 의견을 남겨주십시오.\n(하루 최대 10개까지 작성 가능합니다)");
    
    if (!message || message.trim() === "") {
        return;
    }
    
    const fingerprint = generateDeviceFingerprint();

    const requestData = {
        appMode: currentAppMode || "common",
        message: message.trim(),
        fingerprint: fingerprint
    };

    fetch('/api/feedback', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData)
    })
    .then(res => res.json().then(data => ({ status: res.status, body: data })))
    .then(obj => {
        if (obj.status === 200 && obj.body.success) {
            alert("소중한 의견이 성공적으로 접수되었습니다. 검토 후 신속히 반영하겠습니다.");
        } else {
            alert(`[안내] ${obj.body.error || "제보 전송에 실패했습니다."}`);
        }
    })
    .catch(err => {
        console.error("제보 전송 오류:", err);
        alert(`네트워크 연결에 실패했습니다.\n상세: ${err.message}`);
    });
};

window.onload = function() {
    const urlParams = new URLSearchParams(window.location.search);
    const targetId = urlParams.get('id');
    const mode = urlParams.get('mode');
    const year = urlParams.get('year');

    // URL 파라미터에 문제 번호가 있으면 해당 문제로 즉시 직행 (새로고침 시 화면 유지)
    if (targetId) {
        currentAppMode = (mode === 'written') ? 'written' : 'practical';
        globalTabState = 'all';
        updateBottomTabUI();
        if (year === 'sequential') {
            triggerNewQuizSession('sequential', null, null, parseInt(targetId, 10));
        } else {
            startSingleQuestionQuiz(parseInt(targetId, 10));
        }
    } else {
        loadModeSelectionScreen();
    }
};