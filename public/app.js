let sessionQuizData = [];
let currentQuizIndex = 0;
let savedUserAnswers = {};
let activeSessionId = null;
let revealedAnswers = {};
let globalTabState = "all";

const BOOKMARK_KEY = "정처기_즐겨찾기_목록";

function getBookmarkedQuestions() {
    const data = localStorage.getItem(BOOKMARK_KEY);
    return data ? JSON.parse(data) : [];
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

function switchMainTab(tabType) {
    globalTabState = tabType;
    document.querySelectorAll(".tab-unit").forEach(t => t.classList.remove("active"));
    
    if (tabType === 'all') {
        document.getElementById("tab-all").classList.add("active");
        if (activeSessionId) {
            renderSingleQuestion();
        } else {
            loadMainDashboard();
        }
    } else if (tabType === 'my') {
        document.getElementById("tab-my").classList.add("active");
        if (activeSessionId) {
            if (confirm("현재 진행 중인 모의고사 화면을 빠져나가고 즐겨찾기 메뉴로 이동하시겠습니까?")) {
                activeSessionId = null;
                renderMyBookmarksTab();
            } else {
                document.getElementById("tab-my").classList.remove("active");
                document.getElementById("tab-all").classList.add("active");
            }
        } else {
            renderMyBookmarksTab();
        }
    }
}

async function loadMainDashboard() {
    activeSessionId = null;
    document.getElementById("header-center-title").innerText = "기출 메인 허브";
    const container = document.getElementById("view-renderer");
    
    container.innerHTML = `
        <div style="text-align:center; padding-top:20px;">
            <div style="font-size:50px; margin-bottom:10px;">🎯</div>
            <h3 style="color:#2c3e50; margin-bottom:5px;">정처기 실기 기출 풀이</h3>
            <p style="font-size:13px; color:#7f8c8d; line-height:1.6; margin-bottom:20px; padding:0 15px;">
                원하는 회차의 년도를 선택하거나 기억나는 정답으로 문제를 검색해 보세요.
            </p>
            
            <div style="margin-bottom: 15px; padding: 0 30px;">
                <select id="quiz-year-select" style="width:100%; padding:14px; font-size:15px; border:2px solid #e2e8f0; border-radius:8px; outline:none; color:#2c3e50; font-weight:bold; background-color:#f8f9fa;">
                    <option value="all">전체 년도 무작위 30문항</option>
                    <option value="2021">2021년도 기출 이론 선택</option>
                    <option value="2022">2022년도 기출 이론 선택</option>
                    <option value="2023">2023년도 기출 이론 선택</option>
                </select>
            </div>

            <button class="nav-control-btn" style="width:85%; background-color:#2ecc71; margin-bottom: 25px;" onclick="triggerNewQuizSession()">
                문제풀기 (새로운 회차 시작)
            </button>

            <div style="border-top: 1px dashed #e2e8f0; padding-top: 20px; margin: 0 30px 20px 30px; text-align: left;">
                <span class="input-label-text" style="margin-bottom: 6px;">정답으로 문제 찾기</span>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <input type="text" id="search-answer-input" class="input-answer" placeholder="기억나는 정답 용어 입력" style="margin-bottom: 0; flex: 1;" onkeypress="handleSearchKeyPress(event)">
                    <button class="nav-control-btn" style="padding: 0 16px; width: auto; flex-shrink: 0; background-color: #3498db; height: 48px; border-radius: 8px;" onclick="searchQuestionByAnswer()">검색</button>
                </div>
            </div>
        </div>
        
        <div id="dashboard-dynamic-area">
            <div style="border-left:4px solid #34495e; padding-left:8px; font-weight:bold; color:#34495e; font-size:15px; margin-bottom:15px; margin-top: 10px;">
                회차별 풀이 이력 및 오답확인
            </div>
            <div id="history-ajax-area">이력을 조회하는 중입니다...</div>
        </div>
    `;
    
    fetchHistoryLogs();
}

async function searchQuestionByAnswer() {
    const query = document.getElementById("search-answer-input").value.trim();
    if (!query) {
        alert("검색할 정답 키워드를 입력해 주세요.");
        return;
    }
    
    try {
        const res = await fetch(`/api/quiz/search?answer=${encodeURIComponent(query)}`);
        const data = await res.json();
        renderSearchResults(data, query);
    } catch(e) {
        alert("검색 연동 중 에러가 발생했습니다.");
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
            
            html += `
                <div class="log-box-card" style="border-top-color: #3498db;">
                    <span class="bookmark-toggle-btn" style="position: absolute; top: 12px; right: 15px;" onclick="toggleBookmarkStatusFromSearch(${idx})">${starChar}</span>
                    <div class="source-tag">${r.source}</div>
                    <div class="question-title" style="font-size: 14px; padding-right: 25px;">문제: ${r.text}</div>
                    ${r.view ? `<div class="box-view" style="font-size:12px; padding:10px; margin-bottom:8px;">${r.view}</div>` : ''}
                    <div style="font-size: 13px; color: #27ae60; font-weight: bold; margin-top: 5px;">출제 정답: ${r.answer}</div>
                    <div style="margin-top: 6px; font-size: 12px; color: #555; background: #f1f2f6; padding: 8px; border-radius: 4px; line-height: 1.4;">
                        설명: ${r.desc}
                    </div>
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
            source: q.source,
            text: q.text,
            view: q.view,
            answer: q.answer,
            desc: q.desc
        });
        const query = document.getElementById("search-answer-input").value.trim();
        renderSearchResults(window.searchCurrentResults, query);
    }
}

function renderMyBookmarksTab() {
    document.getElementById("header-center-title").innerText = "즐겨찾기 보관함 (My)";
    const container = document.getElementById("view-renderer");
    const bookmarks = getBookmarkedQuestions();
    
    if (bookmarks.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding-top:60px; color:#95a5a6;">
                <div style="font-size:45px; margin-bottom:15px;">⭐</div>
                <p style="font-size:14px;">보관된 즐겨찾기 문제가 없습니다.</p>
                <p style="font-size:12px; color:#bdc3c7;">문제 풀이 도중 상단 별 아이콘을 누르면 이곳에 보관됩니다.</p>
            </div>
        `;
        return;
    }
    
    let html = `<p style="font-size:13px; color:#7f8c8d; margin-bottom:15px;">보관된 항목 총 ${bookmarks.length}개</p>`;
    bookmarks.forEach((b, idx) => {
        html += `
            <div class="log-box-card" style="border-top-color: #f1c40f;">
                <span class="bookmark-toggle-btn" style="position:absolute; top:12px; right:15px;" onclick="removeBookmarkFromTab('${b.text}')">★</span>
                <div class="source-tag">${b.source}</div>
                <div class="question-title" style="font-size:14px; padding-right:25px;">${b.text}</div>
                ${b.view ? `<div class="box-view" style="font-size:12px; padding:10px; margin-bottom:8px;">${b.view}</div>` : ''}
                <div style="font-size:13px; color:#27ae60; font-weight:bold; margin-top:5px;">정답 용어: ${b.answer}</div>
                <div style="margin-top:6px; font-size:12px; color:#555; background:#f1f2f6; padding:8px; border-radius:4px; line-height:1.4;">
                    설명: ${b.desc}
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
    container.scrollTop = 0;
}

function removeBookmarkFromTab(text) {
    toggleBookmarkStatus({ text: text });
}

async function fetchHistoryLogs() {
    const area = document.getElementById("history-ajax-area");
    try {
        const res = await fetch('/api/history');
        const data = await res.json();
        
        if (data.length === 0) {
            area.innerHTML = "<p style='color:#999; font-size:13px;'>저장된 기출 완료 기록이 없습니다.</p>";
            return;
        }
        
        let html = "";
        data.reverse().forEach(s => {
            html += `
                <div class="log-box-card">
                    <div style="font-size:12px; color:#95a5a6;">풀이 시점: ${s.date}</div>
                    <div style="font-size:15px; font-weight:bold; margin:6px 0; color:#2c3e50;">최종 점수: ${s.score} / ${s.total} 문항</div>
                    <div style="font-size:13px; color:#e74c3c; font-weight:bold; margin-bottom:10px;">틀린 문제 수: ${s.wrongCount}개</div>
                    <button class="nav-control-btn" style="padding:6px; font-size:12px; background-color:#34495e;" onclick="toggleHistoryWrongList(${s.id})">
                        틀린문제 다시 확인하기
                    </button>
                    <div id="wrong-container-${s.id}" style="display:none; margin-top:5px;">
                        ${s.wrongs.map(w => `
                            <div class="history-wrong-item">
                                <div style="font-weight:bold; color:#2980b9; margin-bottom:3px;">${w.source}</div>
                                <div style="font-weight:bold; color:#333; margin-bottom:4px;">문제: ${w.text}</div>
                                ${w.view ? `<div class="box-view" style="font-size:12px; padding:8px; margin-bottom:6px;">${w.view}</div>` : ''}
                                <div style="color:#c0392b;">제출된 오답: ${w.userAnswer}</div>
                                <div style="color:#27ae60; font-weight:bold;">정답 용어: ${w.realAnswer}</div>
                                <div style="margin-top:4px; font-size:12px; color:#666; background:#fff; padding:6px; border:1px solid #ddd;">해설: ${w.desc}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        });
        area.innerHTML = html;
    } catch(e) {
        area.innerHTML = "이력 바인딩 실패";
    }
}

async function triggerNewQuizSession() {
    const selectedYear = document.getElementById("quiz-year-select").value;
    try {
        const res = await fetch('/api/quiz/new', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year: selectedYear })
        });
        const data = await res.json();
        
        activeSessionId = data.sessionId;
        sessionQuizData = data.questions;
        currentQuizIndex = 0;
        savedUserAnswers = {};
        revealedAnswers = {};
        
        renderSingleQuestion();
    } catch(e) {
        alert("서버 연결에 실패했습니다.");
    }
}

function renderSingleQuestion() {
    const q = sessionQuizData[currentQuizIndex];
    document.getElementById("header-center-title").innerText = "실전 문제풀이 중";
    const container = document.getElementById("view-renderer");
    
    const isBookmarked = isQuestionBookmarked(q.text);
    const starChar = isBookmarked ? "★" : "☆";
    
    let inputHtml = '<div class="input-block-wrapper">';
    if (q.inputCount > 1) {
        for (let i = 0; i < q.inputCount; i++) {
            const cachedValue = savedUserAnswers[q.id] || "";
            const cachedAnswers = cachedValue.split(",").map(s => s.trim());
            const currentVal = cachedAnswers[i] || "";
            inputHtml += `
                <div style="margin-bottom: 10px;">
                    <span class="input-label-text">${i + 1}번 입력란</span>
                    <input type="text" class="input-answer multi-input-${q.id}" data-index="${i}" placeholder="${i + 1}번 정답 입력" value="${currentVal}" oninput="synchronizeMultiAnswer(${q.id}, ${q.inputCount})" onkeypress="handleInputNavigation(event, ${i}, ${q.inputCount})">
                </div>
            `;
        }
    } else {
        const cachedValue = savedUserAnswers[q.id] || "";
        inputHtml += `
            <span class="input-label-text">정답 입력란</span>
            <input type="text" id="active-single-input" class="input-answer" placeholder="여기에 주관식 정답을 기입하세요" value="${cachedValue}" oninput="synchronizeSingleAnswer(${q.id}, this.value)" onkeypress="handleSingleKeyPress(event)">
        `;
    }
    inputHtml += '</div>';
    
    let html = `
        <div class="step-panel-header">
            <div class="step-label">문항 기입: ${currentQuizIndex + 1} / ${sessionQuizData.length}</div>
            <span class="bookmark-toggle-btn" id="bookmark-icon" onclick="handleBookmarkClick()">${starChar}</span>
        </div>
        <div class="source-tag">${q.source}</div>
        <div class="question-title">${q.text}</div>
        ${q.view ? `<div class="box-view">${q.view}</div>` : ''}
        
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
    `;
    
    container.innerHTML = html;
    container.scrollTop = 0;
    
    if (revealedAnswers[q.id]) {
        showAnswerBoxInline(q);
    }

    focusInitialField(q);
}

function focusInitialField(q) {
    if (q.inputCount > 1) {
        const firstInput = document.querySelector(`.multi-input-${q.id}[data-index="0"]`);
        if (firstInput) firstInput.focus();
    } else {
        const singleInput = document.getElementById("active-single-input");
        if (singleInput) singleInput.focus();
    }
}

function handleBookmarkClick() {
    const q = sessionQuizData[currentQuizIndex];
    toggleBookmarkStatus({
        source: q.source,
        text: q.text,
        view: q.view,
        answer: q.answer,
        desc: q.desc
    });
}

function toggleInstantFeedbackReveal(qId) {
    const q = sessionQuizData[currentQuizIndex];
    if (revealedAnswers[qId]) {
        revealedAnswers[qId] = false;
        hideAnswerBoxInline();
    } else {
        revealedAnswers[qId] = true;
        showAnswerBoxInline(q);
    }
}

function showAnswerBoxInline(q) {
    const panelArea = document.getElementById("instant-reveal-area");
    if (!panelArea) return;
    
    panelArea.innerHTML = `
        <div class="instant-feedback-panel">
            <div style="font-weight:bold; color:#15803d; margin-bottom:5px;">출제 정답: ${q.answer}</div>
            <div style="font-size:14px; color:#166534; border-top:1px solid #bbf7d0; padding-top:6px; margin-top:5px;">
                설명 주석: ${q.desc}
            </div>
        </div>
    `;
    
    const actionCard = document.getElementById("main-action-trigger-card");
    if (actionCard) {
        actionCard.innerText = "확인 완료";
        actionCard.style.backgroundColor = "#16a34a";
    }
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

function synchronizeMultiAnswer(qId, count) {
    const answers = [];
    for (let i = 0; i < count; i++) {
        const inputElement = document.querySelector(`.multi-input-${qId}[data-index="${i}"]`);
        answers.push(inputElement ? inputElement.value.trim() : "");
    }
    savedUserAnswers[qId] = answers.join(", ");
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

function moveStep(dir) {
    if (dir === 1 && currentQuizIndex === sessionQuizData.length - 1) {
        submitQuizAnswers();
        return;
    }
    currentQuizIndex += dir;
    renderSingleQuestion();
}

async function submitQuizAnswers() {
    const res = await fetch('/api/quiz/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, userAnswers: savedUserAnswers })
    });
    const result = await res.json();
    renderReviewResult(result);
}

function renderReviewResult(result) {
    document.getElementById("header-center-title").innerText = "채점 분석 리포트";
    const view = document.getElementById("view-renderer");
    activeSessionId = null;
    
    let html = `
        <div style="text-align:center; padding:15px 0;">
            <h3 style="margin:0; color:#2c3e50;">제출 처리 완료</h3>
            <h2 style="color:#e74c3c; font-size:36px; margin:10px 0;">${result.score} / ${result.total}</h2>
            <button class="nav-control-btn" style="width:80%;" onclick="loadMainDashboard()">대시보드 메인으로 복귀</button>
        </div>
        <h4 style="color:#34495e; border-bottom:2px solid #34495e; padding-bottom:5px; margin-bottom:15px;">문항별 스크롤 상세 리뷰</h4>
    `;
    
    result.reviewData.forEach((r, idx) => {
        html += `
            <div class="log-box-card" style="border-top-color: ${r.isRight ? '#2ecc71' : '#e74c3c'}">
                <div class="source-tag">${idx + 1}번 항목 | 출처: ${r.source} [${r.isRight ? 'PASS' : 'FAIL'}]</div>
                <div class="question-title" style="font-size:14px; margin-bottom:8px;">문제: ${r.text}</div>
                ${r.view ? `<div class="box-view" style="font-size:12px; padding:10px; margin-bottom:8px;">${r.view}</div>` : ''}
                <div style="font-size:13px; margin:2px 0;">작성 답안: <span style="font-weight:bold; color:${r.isRight ? '#27ae60':'#c0392b'}">${r.userAnswer || "미입력"}</span></div>
                <div style="font-size:13px; margin:2px 0; color:#27ae60; font-weight:bold;">정답 용어: ${r.realAnswer}</div>
                <div style="margin-top:6px; font-size:12px; color:#555; background:#f1f2f6; padding:8px; border-radius:4px; line-height:1.4;">
                    설명: ${r.desc}
                </div>
            </div>
        `;
    });
    
    view.innerHTML = html;
    view.scrollTop = 0;
}

function toggleHistoryWrongList(id) {
    const area = document.getElementById("wrong-container-" + id);
    area.style.display = area.style.display === "none" ? "block" : "none";
}

function exitToDashboard() {
    if (activeSessionId) {
        if (confirm("현재 회차 진행 정보가 손실됩니다. 메인 대시보드로 돌아가시겠습니까?")) {
            loadMainDashboard();
        }
    } else {
        loadMainDashboard();
    }
}

window.onload = loadMainDashboard;