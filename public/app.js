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
let currentCertType = 'qnet'; // 기본값 정보처리기사 고정

// 2종 자격증 메타데이터 (SQLD 배제)
const CERT_METAS = {
    qnet: {
        id: "qnet",
        name: "정보처리기사",
        badge: "2026 합격 케어 패스",
        sub: "목표하시는 시험 단계를 선택하고<br>맞춤형 학습을 시작하세요.",
        writtenTag: "객관식 5과목",
        writtenTitle: "필기 모드",
        writtenDesc: "100문항 CBT 실전 테스트 & 과목별 기출",
        practicalTag: "주관식 / 단답형",
        practicalTitle: "실기 모드",
        practicalDesc: "부분점수 채점 & 핵심 용어 검색",
        hasPractical: true
    },
    net2: {
        id: "net2",
        name: "네트워크관리사 2급",
        badge: "국가공인 민간자격 필기 집중",
        sub: "네트워크관리사 2급 필기 기출문제를 풀이하고<br>실시간 자동 채점을 확인하세요.",
        writtenTag: "객관식 4과목",
        writtenTitle: "필기 모드",
        writtenDesc: "50문항 CBT 실전 테스트 & 19개 회차 풀이",
        practicalTag: "주관식 / 실무 (준비중)",
        practicalTitle: "실기 모드",
        practicalDesc: "네트워크관리사 2급 실기 모드는 준비 중입니다",
        hasPractical: false
    }
};

// 자격증 유형별 동적 키/경로 헬퍼
function getBookmarkKey() { return currentCertType === 'net2' ? 'net2_즐겨찾기_목록' : '정처기_즐겨찾기_목록'; }
function getHistoryKey() { return currentCertType === 'net2' ? 'net2_이력_목록' : '정처기_이력_목록'; }
function getSeqSaveKey() { return currentCertType === 'net2' ? 'net2_순차풀이_중간저장' : '정처기_순차풀이_중간저장'; }
function getApiBase() { return currentCertType === 'net2' ? '/api/net2' : '/api/quiz'; }
function getCertTitle() { return CERT_METAS[currentCertType] ? CERT_METAS[currentCertType].name : '정보처리기사'; }

let quizTimerInterval = null;
let remainingTimeSeconds = 0;

const BOOKMARK_KEY = "정처기_즐겨찾기_목록";
const HISTORY_KEY = "정처기_이력_목록";

// 2026년 정기 기사 3회 시험 일정 데이터
const QNET_EXAM_SCHEDULE = {
    title: "2026년 정기 기사 3회",
    written: {
        apply: "2026.07.20 ~ 2026.07.23",
        extraApply: "2026.08.01 ~ 2026.08.02",
        start: "2026-08-07",
        end: "2026-09-01",
        displayPeriod: "2026.08.07 ~ 2026.09.01",
        passDate: "2026.09.09"
    },
    practical: {
        apply: "2026.09.21 ~ 2026.09.28",
        extraApply: "2026.10.18 ~ 2026.10.19",
        start: "2026-10-24",
        end: "2026-11-13",
        displayPeriod: "2026.10.24 ~ 2026.11.13",
        passDate: "2026.12.18"
    }
};

// 테마 토글 및 초기화 함수
function initTheme() {
    const saved = localStorage.getItem("cbt_theme") || "light";
    document.documentElement.setAttribute("data-theme", saved);
    updateThemeButtonUI(saved);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = (current === "dark") ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("cbt_theme", next);
    updateThemeButtonUI(next);
    logUserAction("THEME_TOGGLE", { theme: next });
}

function updateThemeButtonUI(theme) {
    const btn = document.getElementById("theme-toggle-btn");
    if (btn) {
        btn.innerHTML = (theme === "dark") ? "☀️" : "🌙";
        btn.setAttribute("title", (theme === "dark") ? "라이트 모드로 전환" : "다크 모드로 전환");
    }
}

// D-Day 계산 헬퍼 함수
function getExamDDayInfo() {
    const targetSchedule = (currentAppMode === "written") ? QNET_EXAM_SCHEDULE.written : QNET_EXAM_SCHEDULE.practical;
    const modeName = (currentAppMode === "written") ? "필기 시험" : "실기 시험";
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const startDate = new Date(targetSchedule.start);
    const endDate = new Date(targetSchedule.end);
    
    const diffTime = startDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    let badgeText = "";
    let descText = "";
    
    if (diffDays > 0) {
        badgeText = `D-${diffDays}`;
        descText = `${diffDays}일 남음`;
    } else if (today >= startDate && today <= endDate) {
        badgeText = "진행중";
        descText = "시험 기간";
    } else if (diffDays === 0) {
        badgeText = "D-DAY";
        descText = "시험 당일";
    } else {
        badgeText = "종료";
        descText = "시험 종료";
    }
    
    return {
        badgeText: badgeText,
        descText: descText,
        examName: `${QNET_EXAM_SCHEDULE.title} ${modeName}`,
        period: targetSchedule.displayPeriod,
        passDate: targetSchedule.passDate,
        schedule: targetSchedule
    };
}

function updateHeaderDDayBadge() {
    const badge = document.getElementById("header-dday-badge");
    if (!badge) return;
    
    if (!currentAppMode || currentCertType === 'net2') {
        badge.style.display = "none";
        return;
    }
    
    badge.style.display = "inline-flex";
    badge.innerText = "시험일정";
}

// Q-Net 시험 일정 모달 제어
function openScheduleModal() {
    const modal = document.getElementById("schedule-modal");
    const body = document.getElementById("schedule-modal-body");
    if (!modal || !body) return;
    
    const ddayInfo = getExamDDayInfo();
    
    body.innerHTML = `
        <div style="text-align:center; padding:10px 0 14px 0; border-bottom:1px solid var(--border-color);">
            <div style="font-size:12px; color:var(--text-muted); font-weight:700;">현재 목표 시험</div>
            <div style="font-size:18px; font-weight:900; color:var(--text-title); margin:3px 0;">${ddayInfo.examName}</div>
            <div style="display:inline-block; margin-top:6px; padding:4px 12px; background-color:var(--dday-badge-bg); color:var(--dday-badge-text); border-radius:14px; font-weight:800; font-size:13px;">
                ${ddayInfo.badgeText} (${ddayInfo.descText})
            </div>
        </div>

        <div class="schedule-card-row">
            <div class="schedule-badge-title">
                <span>📝 2026년 정기 기사 3회 [필기]</span>
                <span style="font-size:11px; color:#2563eb;">8월 시험</span>
            </div>
            <div class="schedule-item-line"><strong>원서접수:</strong> ${QNET_EXAM_SCHEDULE.written.apply}</div>
            <div class="schedule-item-line"><strong>빈자리접수:</strong> ${QNET_EXAM_SCHEDULE.written.extraApply}</div>
            <div class="schedule-item-line"><strong>시험일정:</strong> ${QNET_EXAM_SCHEDULE.written.displayPeriod}</div>
            <div class="schedule-item-line"><strong>합격발표:</strong> ${QNET_EXAM_SCHEDULE.written.passDate}</div>
        </div>

        <div class="schedule-card-row">
            <div class="schedule-badge-title">
                <span>💻 2026년 정기 기사 3회 [실기]</span>
                <span style="font-size:11px; color:#16a34a;">10월 시험</span>
            </div>
            <div class="schedule-item-line"><strong>원서접수:</strong> ${QNET_EXAM_SCHEDULE.practical.apply}</div>
            <div class="schedule-item-line"><strong>빈자리접수:</strong> ${QNET_EXAM_SCHEDULE.practical.extraApply}</div>
            <div class="schedule-item-line"><strong>시험일정:</strong> ${QNET_EXAM_SCHEDULE.practical.displayPeriod}</div>
            <div class="schedule-item-line"><strong>최종발표:</strong> ${QNET_EXAM_SCHEDULE.practical.passDate}</div>
        </div>
    `;
    
    modal.style.display = "flex";
}

function closeScheduleModal(event) {
    const modal = document.getElementById("schedule-modal");
    if (modal) modal.style.display = "none";
}

// 사용자 활동 로그 비동기 전송 함수 (SQLite 연동)
function logUserAction(action, detail = {}) {
    try {
        const payload = JSON.stringify({
            fingerprint: generateDeviceFingerprint(),
            action: action,
            detail: detail
        });

        if (navigator.sendBeacon) {
            const blob = new Blob([payload], { type: 'application/json' });
            navigator.sendBeacon('/api/log', blob);
        } else {
            fetch('/api/log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }).catch(() => {});
        }
    } catch (e) {}
}

function formatViewHtml(view) {
    if (!view) return "";

    if (/<table[^>]*>[\s\S]*<tr/i.test(view) || /<(pre|code|svg)[^>]*>/i.test(view)) {
        return view.replace(/<(\/?[SRAB]|보기)>/gi, '[$1]');
    }

    let text = escapeHtml(view);

    let bogiHtml = "";
    let bogiRegex = /(?:&lt;|<|\[|\()\s*(?:보기|디자인\s*패턴\s*목록|보기\s*목록)\s*(?:&gt;|>|\]|\))?:?([\s\S]*)/i;
    let bogiMatch = text.match(bogiRegex);

    if (bogiMatch) {
        let bogiRaw = bogiMatch[1].trim();
        text = text.substring(0, bogiMatch.index).trim();
        
        let bogiItems = bogiRaw.split(/[\n\|]|\s+\/\s+/).map(s => s.trim().replace(/^[•·\-\*]\s*/, '')).filter(s => s.length > 0);
        let chips = bogiItems.map(item => {
            const safeVal = item.replace(/'/g, "\\'").replace(/"/g, "&quot;");
            return `<span class="view-bogi-chip" onclick="handleChoiceClick('${safeVal}')">${item}</span>`;
        }).join('');

        if (chips) {
            bogiHtml = `
                <div class="view-bogi-container">
                    <div class="view-bogi-title">📋 [보기]</div>
                    <div class="view-bogi-chip-wrap">${chips}</div>
                </div>
            `;
        }
    }

    let blocks = text.split(/\n\s*\n/);
    let resultHtml = "";

    blocks.forEach(block => {
        let lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return;

        let caption = "";
        let firstLine = lines[0];
        if (/^(&lt;|\[|<)[^>\]]+(&gt;|\]|>)(.*)$/.test(firstLine) && !firstLine.includes('|')) {
            caption = firstLine;
            lines = lines.slice(1);
        }

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
        let isSourceCode = /int\s+Main|#include|public\s+class|class\s+\w+|void\s+\w+|return\s+\d+|while\s*\(|if\s*\(/i.test(blockContent);
        let isFlowChart = lines.some(l => l.includes('->') || l.includes('→')) && lines.some(l => l.includes('[') || l.includes('<'));

        if (isSourceCode || isFlowChart) {
            resultHtml += `<div class="code-flow-box">${lines.join('<br>')}</div>`;
            return;
        }

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

    let cleanedText = String(rawText).replace(/\s*\(\s*\d+점\s*\)/g, "");

    function highlightBlanks(str) {
        return escapeHtml(str).replace(/(?<![a-zA-Z0-9_])\(\s*([①-⑮㉠-㉾ㄱ-ㅎ]?)\s*\)/g, function(match, p1) {
            let inner = p1.trim() ? p1.trim() : "&nbsp;&nbsp;";
            return `<span class="q-blank">(&nbsp;${inner}&nbsp;)</span>`;
        });
    }

    let firstBreakIndex = cleanedText.indexOf("\n");
    if (firstBreakIndex === -1) {
        return `<div class="q-title-instruction" id="question-focus-target" tabindex="-1" style="outline: none;">${highlightBlanks(cleanedText)}</div>`;
    }

    let instruction = cleanedText.substring(0, firstBreakIndex).trim();
    let bodyText = cleanedText.substring(firstBreakIndex + 1).trim();

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
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 전문 가시성 강화 해설 HTML 렌더러
function formatExplanationHtml(rawDesc) {
    if (!rawDesc) return "";
    let desc = String(rawDesc).replace(/\[cite:\s*[\d,\s]+\]/gi, "").trim();
    if (!desc) return "";
    desc = escapeHtml(desc);

    const lines = desc.split('\n').map(l => l.trimEnd());
    let html = '<div class="explanation-container">';
    let inWrongSection = false;
    let inConceptSection = false;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) continue;

        // 1) [오답 풀이] 헤더 감지
        if (/^\[오답\s*(풀이|해설)\]$/i.test(line)) {
            if (inConceptSection) { html += '</div>'; inConceptSection = false; }
            if (inWrongSection) { html += '</div>'; }
            inWrongSection = true;
            html += `
                <div class="desc-section-group desc-wrong-group">
                    <div class="desc-section-header">
                        <span class="desc-section-badge badge-wrong">❌ 오답 풀이</span>
                    </div>
            `;
            continue;
        }

        // 2) [보충 개념] 헤더 감지
        if (/^\[(보충|핵심|관련)\s*개념\]$|^\[참고\]$/i.test(line)) {
            if (inWrongSection) { html += '</div>'; inWrongSection = false; }
            if (inConceptSection) { html += '</div>'; }
            inConceptSection = true;
            const titleMatch = line.match(/^\[(.*)\]$/);
            const titleText = titleMatch ? titleMatch[1] : "보충 개념";
            html += `
                <div class="desc-section-group desc-concept-group">
                    <div class="desc-section-header">
                        <span class="desc-section-badge badge-concept">💡 ${titleText}</span>
                    </div>
            `;
            continue;
        }

        // 3) 선택지 항목 (- 1번: ...) 감지
        const choiceItemMatch = line.match(/^[-•·*]?\s*([①-④1-4A-Za-z]번?|[①-④A-Za-z]|\([A-Za-z\d]+\))\s*(?:\([^)]+\))?\s*[:：]\s*(.*)$/);
        if (choiceItemMatch) {
            let numLabel = choiceItemMatch[1];
            if (!numLabel.endsWith('번') && /^[1-4]$/.test(numLabel)) numLabel += '번';
            const content = choiceItemMatch[2];
            html += `
                <div class="desc-choice-item">
                    <span class="desc-num-chip">${numLabel}</span>
                    <span class="desc-choice-text">${content}</span>
                </div>
            `;
            continue;
        }

        // 4) 정답 서두 문장 (정답: 2. ...) 감지
        const answerHeadMatch = line.match(/^정답\s*[:：]\s*([①-④\d]+)\.?\s*(.*)$/);
        if (answerHeadMatch && !inWrongSection && !inConceptSection) {
            const ansNum = answerHeadMatch[1];
            const ansBody = answerHeadMatch[2];
            html += `
                <div class="desc-lead-block">
                    <span class="desc-lead-badge">정답 ${ansNum}번</span>
                    <span class="desc-lead-text">${ansBody}</span>
                </div>
            `;
            continue;
        }

        // 5) 일반 문장
        if (inConceptSection) {
            html += `<div class="desc-concept-line">${line}</div>`;
        } else if (inWrongSection) {
            html += `<div class="desc-plain-line">${line}</div>`;
        } else {
            html += `<div class="desc-main-paragraph">${line}</div>`;
        }
    }

    if (inWrongSection || inConceptSection) {
        html += '</div>';
    }
    html += '</div>';
    return html;
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
    const data = localStorage.getItem(getBookmarkKey());
    return data ? JSON.parse(data) : [];
}

function getHistoryLogs() {
    const data = localStorage.getItem(getHistoryKey());
    return data ? JSON.parse(data) : [];
}

function deleteHistoryLog(logId) {
    if (confirm("해당 풀이 기록을 삭제하시겠습니까?")) {
        let history = getHistoryLogs();
        history = history.filter(h => h.id !== logId);
        localStorage.setItem(getHistoryKey(), JSON.stringify(history));
        fetchHistoryLogs();
    }
}

// 학습 데이터 백업 (JSON 파일 다운로드)
function exportBackupData() {
    logUserAction("BACKUP_DATA");
    const bookmarks = getBookmarkedQuestions();
    const history = getHistoryLogs();
    const seqRaw = localStorage.getItem(getSeqSaveKey());
    const sequentialState = seqRaw ? JSON.parse(seqRaw) : null;

    if (bookmarks.length === 0 && history.length === 0 && !sequentialState) {
        alert("백업할 학습 이력이나 즐겨찾기 데이터가 없습니다.");
        return;
    }

    const backupPayload = {
        app: getCertTitle() + " 스마트 기출 풀이",
        version: "2026.10",
        exportedAt: new Date().toLocaleString('ko-KR'),
        bookmarks: bookmarks,
        history: history,
        sequentialState: sequentialState
    };

    const blob = new Blob([JSON.stringify(backupPayload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');

    a.href = url;
    const certPrefix = currentCertType === 'net2' ? 'net2' : '정처기';
    a.download = `${certPrefix}_학습데이터_백업_${yyyy}${mm}${dd}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function triggerRestoreFileInput() {
    const fileInput = document.getElementById("backup-file-input");
    if (fileInput) {
        fileInput.value = "";
        fileInput.click();
    }
}

function importBackupData(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (!data || (!Array.isArray(data.bookmarks) && !Array.isArray(data.history))) {
                alert("올바른 학습 백업 파일 형식이 아닙니다.");
                return;
            }

            const bookmarkCount = Array.isArray(data.bookmarks) ? data.bookmarks.length : 0;
            const historyCount = Array.isArray(data.history) ? data.history.length : 0;

            const confirmMsg = `백업 파일 정보를 확인했습니다.\n- 즐겨찾기: ${bookmarkCount}건\n- 풀이 이력: ${historyCount}건\n\n현재 기기의 데이터를 백업 파일 내용으로 복원하시겠습니까?`;
            if (!confirm(confirmMsg)) return;

            if (Array.isArray(data.bookmarks)) {
                localStorage.setItem(getBookmarkKey(), JSON.stringify(data.bookmarks));
            }
            if (Array.isArray(data.history)) {
                localStorage.setItem(getHistoryKey(), JSON.stringify(data.history));
            }
            if (data.sequentialState) {
                localStorage.setItem(getSeqSaveKey(), JSON.stringify(data.sequentialState));
            }

            logUserAction("RESTORE_DATA", { bookmarks: bookmarkCount, history: historyCount });
            alert("학습 데이터가 성공적으로 복원되었습니다.");
            const tabMy = document.getElementById("tab-my");
            if (tabMy && tabMy.classList.contains("active")) {
                renderMyBookmarksTab();
            } else {
                loadMainDashboard();
            }
        } catch (err) {
            console.error("복원 파싱 에러:", err);
            alert("파일을 읽고 복원하는 중 오류가 발생했습니다: " + err.message);
        }
    };
    reader.readAsText(file, "utf-8");
}

function toggleBookmarkStatus(questionObj) {
    let bookmarks = getBookmarkedQuestions();
    const existsIdx = bookmarks.findIndex(b => b.text === questionObj.text);
    
    if (existsIdx > -1) {
        bookmarks.splice(existsIdx, 1);
    } else {
        bookmarks.push(questionObj);
    }
    localStorage.setItem(getBookmarkKey(), JSON.stringify(bookmarks));
    
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

function switchMainTab(tabType, isPopstate = false) {
    globalTabState = tabType;
    updateBottomTabUI();
    
    if (tabType === 'all') {
        if (activeSessionId) {
            renderSingleQuestion();
        } else {
            loadMainDashboard(isPopstate);
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
                if (!isPopstate) history.pushState({ screen: 'tab', tab: 'my', cert: currentCertType, mode: currentAppMode }, '');
                renderMyBookmarksTab();
            } else {
                globalTabState = 'all';
                updateBottomTabUI();
            }
        } else {
            if (!isPopstate) history.pushState({ screen: 'tab', tab: 'my', cert: currentCertType, mode: currentAppMode }, '');
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
                if (!isPopstate) history.pushState({ screen: 'tab', tab: 'analysis', cert: currentCertType, mode: currentAppMode }, '');
                renderAnalysisTab();
            } else {
                globalTabState = 'all';
                updateBottomTabUI();
            }
        } else {
            if (!isPopstate) history.pushState({ screen: 'tab', tab: 'analysis', cert: currentCertType, mode: currentAppMode }, '');
            renderAnalysisTab();
        }
    }
}

function switchAppMode() {
    if (currentCertType === 'net2') {
        alert("네트워크관리사 2급은 현재 필기 모드만 지원됩니다.\n(실기 모드는 추후 업데이트 예정입니다)");
        return;
    }
    if (activeSessionId) {
        if (!confirm("현재 진행 중인 시험 내역이 초기화됩니다. 모드를 전환하시겠습니까?")) return;
    }
    clearInterval(quizTimerInterval);
    activeSessionId = null;
    activeSessionYear = null;
    activeSessionType = null;
    history.replaceState(null, '', window.location.pathname);
    
    currentAppMode = (currentAppMode === 'practical') ? 'written' : 'practical';
    logUserAction("MODE_SWITCH", { newMode: currentAppMode });
    globalTabState = 'all';
    
    updateBottomTabUI();
    updateHeaderDDayBadge();
    loadMainDashboard();
}

function setAppMode(mode, isPopstate = false) {
    currentAppMode = mode;
    logUserAction("MODE_SELECT", { mode: mode, cert: currentCertType });
    globalTabState = 'all';
    if (!isPopstate) {
        history.pushState({ screen: 'dashboard', mode: mode, cert: currentCertType }, '', `?mode=${mode}&cert=${currentCertType}`);
    }
    updateBottomTabUI();
    updateHeaderDDayBadge();
    loadMainDashboard(isPopstate);
}

function switchCertification(type) {
    if (currentCertType === type) return;
    currentCertType = type;
    logUserAction("CERT_SWITCH", { cert: type });
    loadModeSelectionScreen();
}

function handlePracticalCardClick() {
    const meta = CERT_METAS[currentCertType] || CERT_METAS.qnet;
    if (!meta.hasPractical) {
        alert("네트워크관리사 2급 실기 모드는 현재 준비 중입니다.\n(필기 모드를 이용해 주세요)");
        return;
    }
    setAppMode('practical');
}

function loadModeSelectionScreen(isPopstate = false) {
    clearInterval(quizTimerInterval);
    if (!isPopstate) {
        history.replaceState({ screen: 'main', cert: currentCertType }, '', window.location.pathname);
    }
    document.querySelector(".tab-fixed-bar").style.display = "none";
    document.querySelector(".header").style.display = "none";
    currentAppMode = null;
    activeSessionId = null;
    activeSessionYear = null;
    activeSessionType = null;
    
    logUserAction("MAIN_PAGE_VIEW");
    
    const meta = CERT_METAS[currentCertType] || CERT_METAS.qnet;
    const isQnet = (currentCertType === 'qnet');
    
    const container = document.getElementById("view-renderer");
    container.innerHTML = `
        <div class="mode-select-container">
            <!-- 상단 2종 캡슐 칩 스위처 (A안) -->
            <div class="cert-chip-container">
                <div class="cert-chip ${isQnet ? 'active' : ''}" onclick="switchCertification('qnet')">정보처리기사</div>
                <div class="cert-chip ${!isQnet ? 'active' : ''}" onclick="switchCertification('net2')">네트워크관리사 2급</div>
            </div>

            <div class="hero-badge">${meta.badge}</div>
            <h1 class="hero-title">${meta.name}<br>스마트 기출 풀이</h1>
            <p class="hero-sub">${meta.sub}</p>
            
            <div class="mode-card-group">
                <div class="modern-mode-card written" onclick="setAppMode('written')">
                    <div class="card-icon-wrapper written-bg">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.2 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                    </div>
                    <div class="card-content">
                        <div class="card-tag written-tag">${meta.writtenTag}</div>
                        <div class="card-title">${meta.writtenTitle}</div>
                        <div class="card-desc">${meta.writtenDesc}</div>
                    </div>
                    <div class="card-arrow">➔</div>
                </div>
                
                <div class="modern-mode-card practical" onclick="handlePracticalCardClick()">
                    <div class="card-icon-wrapper practical-bg">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                    </div>
                    <div class="card-content">
                        <div class="card-tag practical-tag">${meta.practicalTag}</div>
                        <div class="card-title">${meta.practicalTitle}</div>
                        <div class="card-desc">${meta.practicalDesc}</div>
                    </div>
                    <div class="card-arrow">➔</div>
                </div>
            </div>

            <footer class="app-footer">
                <div class="footer-inner">
                    <p class="brand-title">MakeSoft</p>
                    <p class="disclaimer-text">
                        본 서비스에서 제공하는 문제는 수험생 복원 데이터 및 출제 기준을 바탕으로 학습 편의를 위해 독자적으로 재구성된 자료입니다. 
                        공식 출제기관의 원문 시험지가 아니며, 실제 출제 문항과 일부 문장 표현에 차이가 있을 수 있습니다.
                    </p>
                    <p class="copyright-text">© 2026 MakeSoft. All rights reserved.</p>
                </div>
            </footer>
        </div>
    `;
}

function getSubjectName(q) {
    if (currentCertType === 'net2') {
        return q.subject || "네트워크관리사 필기 공통";
    }
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

// 성과 분석 화면 (정상 평균/합격률 산출 로직 적용)
function renderAnalysisTab() {
    const isWritten = (currentAppMode === 'written');
    document.getElementById("header-center-title").innerText = isWritten ? "필기 성과 분석" : "실기 성과 분석";
    const container = document.getElementById("view-renderer");
    
    const logs = getHistoryLogs().filter(log => log.type === currentAppMode);
    
    if (logs.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding-top:60px; color:var(--text-light);">
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
        const qCount = log.total || (log.questions ? log.questions.length : 0);
        totalScoreSum += log.score;
        totalQuestionSum += qCount;
        
        // 60점 이상 합격
        if (log.score >= 60) {
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

    let avgPercent = totalExamCount > 0 ? Math.round(totalScoreSum / totalExamCount) : 0;
    let passPercent = totalExamCount > 0 ? Math.round((passCount / totalExamCount) * 100) : 0;

    let subjectCardsHtml = "";
    Object.keys(subjectStatsMap).forEach(subjectName => {
        const stat = subjectStatsMap[subjectName];
        const subjectPercent = stat.total > 0 ? Math.round((stat.correct / stat.total) * 100) : 0;
        
        let wrongList = Object.values(stat.wrongQuestions).sort((a, b) => b.count - a.count).slice(0, 3);
        let wrongItemsHtml = "";

        if (wrongList.length > 0) {
            wrongItemsHtml = wrongList.map(w => `
                <div style="font-size:12px; color:#c0392b; background:var(--bg-sub-box); padding:8px 10px; border-radius:6px; margin-top:6px; border:1px solid #fadbd8; text-align:left; cursor:pointer;" onclick="startSingleQuestionQuiz(${w.id})">
                    <div style="font-weight:bold; display:flex; justify-content:space-between;">
                        <span>[${w.source}] - ${w.count}회 오답</span>
                        <span style="color:var(--primary); text-decoration:underline;">[문제풀기 ➔]</span>
                    </div>
                    <div style="color:var(--text-main); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px;">${escapeHtml(w.text)}</div>
                </div>
            `).join("");
        } else {
            wrongItemsHtml = `<div style="font-size:12px; color:#2ecc71; margin-top:6px;">틀린 문제가 없습니다. 우수한 성적입니다!</div>`;
        }

        subjectCardsHtml += `
            <div class="log-box-card" style="border-top-color: var(--primary); margin-bottom:15px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-weight:bold; color:var(--text-title); font-size:15px;">${subjectName}</span>
                    <span style="font-weight:bold; color:${subjectPercent >= 60 ? '#10b981' : '#ef4444'}; font-size:15px;">${subjectPercent}%</span>
                </div>
                <div style="width:100%; background:var(--border-color); height:8px; border-radius:4px; overflow:hidden; margin-bottom:10px;">
                    <div style="width:${subjectPercent}%; background:${subjectPercent >= 60 ? '#10b981' : '#ef4444'}; height:100%;"></div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:12px; color:var(--text-muted);">총 ${stat.total}문항 중 ${stat.correct}문항 맞춤</span>
                    <button class="nav-control-btn" style="padding:6px 10px; font-size:12px; background-color:var(--primary); width:auto;" onclick="startSubjectQuiz('${subjectName}')">이 과목만 풀기</button>
                </div>
                <div style="font-size:13px; font-weight:bold; color:var(--text-title); margin-top:10px; text-align:left;">해당 과목 자주 틀리는 취약 문제 (클릭 시 풀기)</div>
                ${wrongItemsHtml}
            </div>
        `;
    });

    let html = `
        <div style="padding-top:6px;">
            <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:12px; padding:15px; margin-bottom:16px; text-align:center;">
                <div style="font-weight:bold; color:var(--text-title); font-size:15.5px; margin-bottom:12px;">🏆 전체 누적 응시 리포트</div>
                <div style="display:flex; justify-content:space-around; background:var(--bg-sub-box); padding:12px; border-radius:8px; border:1px solid var(--border-color);">
                    <div>
                        <div style="font-size:11px; color:var(--text-muted);">총 응시 횟수</div>
                        <div style="font-size:18px; font-weight:bold; color:var(--text-title);">${totalExamCount}회</div>
                    </div>
                    <div>
                        <div style="font-size:11px; color:var(--text-muted);">평균 정답률</div>
                        <div style="font-size:18px; font-weight:bold; color:var(--primary);">${avgPercent}%</div>
                    </div>
                    <div>
                        <div style="font-size:11px; color:var(--text-muted);">합격률</div>
                        <div style="font-size:18px; font-weight:bold; color:#10b981;">${passPercent}%</div>
                    </div>
                </div>
            </div>

            <h4 style="color:var(--text-title); border-bottom:2px solid var(--border-color); padding-bottom:6px; margin-bottom:14px; font-size:14px;">과목별 정답률 및 취약 문제 분석</h4>
            ${subjectCardsHtml}
        </div>
    `;

    container.innerHTML = html;
    container.scrollTop = 0;
}

// 대시보드 렌더러 (D-Day 배너 + 연도별 선택)
function loadMainDashboard(isPopstate = false) {
    clearInterval(quizTimerInterval);
    if (!currentAppMode) {
        loadModeSelectionScreen(isPopstate);
        return;
    }
    if (!isPopstate) {
        history.replaceState({ screen: 'dashboard', mode: currentAppMode, cert: currentCertType }, '', `?mode=${currentAppMode}&cert=${currentCertType}`);
    }

    document.querySelector(".tab-fixed-bar").style.display = "flex";
    document.querySelector(".header").style.display = "flex";
    
    activeSessionId = null;
    activeSessionYear = null;
    activeSessionType = null;
    activeInputRef = null;
    
    const isWritten = (currentAppMode === 'written');
    const certLabel = getCertTitle();
    document.getElementById("header-center-title").innerText = isWritten ? certLabel + " 필기" : certLabel + " 실기";
    updateHeaderDDayBadge();
    
    const container = document.getElementById("view-renderer");

    const searchSectionTitle = isWritten ? "정답/해설에서 문제찾기" : "문제 / 정답으로 문제찾기";
    const selectOptionsHtml = isWritten ? `
        <option value="answer">정답</option>
        <option value="desc">해설</option>
    ` : `
        <option value="answer">정답</option>
        <option value="text">문제</option>
    `;
    const defaultPlaceholder = isWritten ? "정답 용어/문구 입력" : "기억나는 정답 용어 입력";

    let dashboardHtml = `
        <div class="dashboard-util-bar">
            <span class="input-label-text">${searchSectionTitle}</span>
            <div class="search-input-group">
                <select id="search-field-select" class="search-select" onchange="updateSearchPlaceholder()">
                    ${selectOptionsHtml}
                </select>
                <input type="text" id="search-answer-input" class="search-input" placeholder="${defaultPlaceholder}" onkeypress="handleSearchKeyPress(event)">
                <button class="search-btn" onclick="searchQuestionByAnswer()">검색</button>
            </div>
        </div>

        <div class="feed-container">
            <!-- 카드 1: 실전 모의고사 (랜덤 추출) -->
            <div class="feed-card">
                <div class="feed-card-header">
                    <span class="feed-badge">${isWritten ? (currentCertType === 'net2' ? '실전 CBT 50제' : '실전 CBT 100제') : (currentCertType === 'net2' ? '랜덤 모의 20제' : '랜덤 모의 30제')}</span>
                    <span class="feed-status-tag">${isWritten ? '전과목 무작위' : (currentCertType === 'net2' ? '핵심 20문항' : '핵심 30문항')}</span>
                </div>
                <div class="feed-card-main">
                    <div class="feed-thumb ${isWritten ? 'written' : 'practical'}">${isWritten ? '📝' : '💻'}</div>
                    <div class="feed-info">
                        <div class="feed-title">${isWritten ? (currentCertType === 'net2' ? '필기 실전 모의고사 (50제)' : '필기 실전 모의고사 (100제)') : (currentCertType === 'net2' ? '실기 무작위 모의고사 (20제)' : '실기 무작위 모의고사 (30제)')}</div>
                        <div class="feed-desc">${isWritten ? (currentCertType === 'net2' ? '전체 필기 기출문제에서 50문항 무작위 추출' : '전체 필기 기출문제에서 100문항 무작위 추출') : (currentCertType === 'net2' ? '전체 실기 기출에서 무작위 20문항 추출' : '전체 실기 기출에서 무작위 30문항 추출')}</div>
                    </div>
                </div>
                <button class="card-action-btn" onclick="triggerNewQuizSession('${isWritten ? 'cbt' : 'all'}')">랜덤 모의고사 시작 ➔</button>
            </div>

            <!-- 카드 2: 기출문제 선택 풀이 (실기: 연도별 선택) -->
            <div class="feed-card">
                <div class="feed-card-header">
                    <span class="feed-badge blue">${isWritten ? '회차별 기출' : '연도별 기출'}</span>
                    <span class="feed-status-tag">선택 풀이</span>
                </div>
                <div class="feed-card-main">
                    <div class="feed-thumb ${isWritten ? 'written' : 'practical'}">🎯</div>
                    <div class="feed-info">
                        <div class="feed-title">${isWritten ? '필기 회차별 기출문제 풀이' : '실기 연도별 기출문제 풀이'}</div>
                        <div class="feed-desc">${isWritten ? '학습을 원하는 연도 및 회차를 선택해 주세요.' : '학습을 원하는 시험 연도를 선택해 주세요.'}</div>
                    </div>
                </div>
                <select id="quiz-round-select" class="feed-select">
                    <option value="">${isWritten ? '데이터베이스에서 회차를 불러오는 중...' : '데이터베이스에서 연도를 불러오는 중...'}</option>
                </select>
                <button class="card-action-btn" onclick="startSelectedRoundQuiz()">${isWritten ? '선택 회차 문제풀기 시작 ➔' : '선택 연도 문제풀기 시작 ➔'}</button>
            </div>

            <!-- 카드 3: 전체 문항 순서대로 풀기 (누적 정복 모드) -->
            <div class="feed-card">
                <div class="feed-card-header">
                    <span class="feed-badge green">누적 정복</span>
                    <span class="feed-status-tag">이어풀기 지원</span>
                </div>
                <div class="feed-card-main">
                    <div class="feed-thumb ${isWritten ? 'written' : 'practical'}">🔁</div>
                    <div class="feed-info">
                        <div class="feed-title">${isWritten ? '필기' : '실기'} 전체 문항 순서대로 풀기</div>
                        <div class="feed-desc">1번부터 차례대로 정복하는 코스 (진행 상황 자동 저장)</div>
                    </div>
                </div>
                <button class="card-action-btn secondary" onclick="triggerNewQuizSession('sequential')">순차 풀이 시작/이어풀기 ➔</button>
            </div>
        </div>

        <div id="dashboard-dynamic-area">
            <div onclick="toggleHistoryAreaVisibility()" style="border-left:4px solid var(--primary); padding-left:8px; font-weight:bold; color:var(--text-title); font-size:14.5px; margin-bottom:12px; margin-top: 10px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
                <span>회차별 풀이 이력 및 오답확인</span>
                <span id="history-toggle-arrow" style="font-size: 12px; margin-right: 6px; color: var(--text-muted);">▼</span>
            </div>
            <div id="history-ajax-area">이력을 조회하는 중입니다...</div>
        </div>
    `;

    container.innerHTML = dashboardHtml;
    fetchHistoryLogs();
    populateRoundSelectOptions();
}

// 실기는 문항수 없이 연도만 옵션으로 생성
async function populateRoundSelectOptions() {
    const selectElem = document.getElementById("quiz-round-select");
    if (!selectElem) return;

    const isWritten = (currentAppMode === 'written');

    try {
        const res = await fetch(`${getApiBase()}/rounds?type=${currentAppMode}`);
        const items = await res.json();
        
        if (items && items.length > 0) {
            if (isWritten) {
                selectElem.innerHTML = items.map(r => 
                    `<option value="${r.name}">${r.name} (${r.count}문항)</option>`
                ).join('');
            } else {
                selectElem.innerHTML = items.map(r => 
                    `<option value="${r.name}">${r.name} 기출문제</option>`
                ).join('');
            }
        } else {
            selectElem.innerHTML = `<option value="">등록된 기출 데이터가 없습니다</option>`;
        }
    } catch (e) {
        console.error("목록 로드 실패:", e);
        selectElem.innerHTML = `<option value="">목록을 불러오지 못했습니다</option>`;
    }
}

// 선택된 연도/회차 기출문제 풀이 시작
function startSelectedRoundQuiz() {
    const selectElem = document.getElementById("quiz-round-select");
    const selectedItem = selectElem ? selectElem.value : "";
    const isWritten = (currentAppMode === 'written');
    if (!selectedItem) {
        alert(isWritten ? "풀이할 회차를 선택해 주세요." : "풀이할 연도를 선택해 주세요.");
        return;
    }
    triggerNewQuizSession(selectedItem);
}

function updateSearchPlaceholder() {
    const selectElem = document.getElementById("search-field-select");
    const inputElem = document.getElementById("search-answer-input");
    if (!selectElem || !inputElem) return;

    const val = selectElem.value;
    const isWritten = (currentAppMode === 'written');

    if (isWritten) {
        if (val === 'answer') {
            inputElem.placeholder = "정답 용어/문구 입력";
        } else if (val === 'desc') {
            inputElem.placeholder = "해설 속 키워드 입력";
        }
    } else {
        if (val === 'answer') {
            inputElem.placeholder = "기억나는 정답 용어 입력";
        } else if (val === 'text') {
            inputElem.placeholder = "문제 지문 속 키워드 입력";
        }
    }
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
    const inputElem = document.getElementById("search-answer-input");
    const selectElem = document.getElementById("search-field-select");
    
    const query = inputElem ? inputElem.value.trim() : "";
    const field = selectElem ? selectElem.value : "answer";

    if (!query) {
        const fieldName = (field === 'desc') ? '해설' : (field === 'text' ? '문제 지문' : '정답');
        alert(`검색할 ${fieldName} 키워드를 입력해 주세요.`);
        return;
    }
    
    try {
        const res = await fetch(`${getApiBase()}/search?query=${encodeURIComponent(query)}&answer=${encodeURIComponent(query)}&type=${currentAppMode}&field=${field}`);
        const rawData = await res.json();
        const data = parseSecurePayload(rawData);
        logUserAction("SEARCH", { mode: currentAppMode, field: field, query: query, resultCount: (data && data.length) || 0 });
        renderSearchResults(data, query, field);
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

function renderSearchResults(results, query, field) {
    const dynamicArea = document.getElementById("dashboard-dynamic-area");
    if (!dynamicArea) return;
    
    const isWritten = (currentAppMode === 'written');
    let fieldTitle = "정답";
    if (isWritten) {
        fieldTitle = (field === 'desc') ? "해설" : "정답";
    } else {
        fieldTitle = (field === 'text') ? "문제" : "정답";
    }

    let html = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 15px; margin-bottom: 15px; border-left: 4px solid var(--primary); padding-left: 8px;">
            <span style="font-weight: bold; color: var(--text-title); font-size: 14px;">'${escapeHtml(query)}' ${fieldTitle} 검색 (총 ${results.length}건)</span>
            <span style="font-size: 12px; color: var(--primary); cursor: pointer; text-decoration: underline; font-weight: bold;" onclick="loadMainDashboard()">이력 목록으로 복귀</span>
        </div>
    `;
    
    if (results.length === 0) {
        html += `<div style="text-align: center; color: var(--text-light); font-size: 13.5px; padding: 30px 0;">해당 ${fieldTitle}을(를) 포함하는 기출문제를 찾을 수 없습니다.</div>`;
    } else {
        results.forEach((r, idx) => {
            const isBookmarked = isQuestionBookmarked(r.text);
            const starChar = isBookmarked ? "★" : "☆";
            const modeText = r.type === 'written' ? '[필기]' : '[실기]';
            let cleanDesc = r.desc ? r.desc.replace(/\[cite:\s*[\d,\s]+\]/gi, "").trim() : "";
            
            let answerDisplay = escapeHtml(r.answer);
            if (r.type === 'written' && r.choices && Array.isArray(r.choices)) {
                const ansIdx = parseInt(r.answer, 10) - 1;
                if (r.choices[ansIdx]) {
                    answerDisplay = `${r.answer}번. ${escapeHtml(r.choices[ansIdx])}`;
                }
            }
            
            html += `
                <div class="log-box-card" style="border-top-color: var(--primary);">
                    <span class="bookmark-toggle-btn" style="position: absolute; top: 12px; right: 15px;" onclick="toggleBookmarkStatusFromSearch(${idx})">${starChar}</span>
                    <div class="source-tag">${modeText} ${r.source}</div>
                    <div class="question-title" style="font-size: 13.5px; padding-right: 25px; white-space: pre-wrap; line-height: 1.55; word-break: break-all;">문제: ${escapeHtml(r.text)}</div>
                    ${r.image ? `<div style="text-align:center; margin-bottom:10px;"><img src="${r.image}" class="question-img" alt="기출 이미지"></div>` : ''}
                    ${r.view ? `<div class="view-content-wrapper">${formatViewHtml(r.view)}</div>` : ''}
                    <div style="font-size: 13px; color: #10b981; font-weight: bold; margin-top: 5px;">출제 정답: ${answerDisplay}</div>
                    ${formatExplanationHtml(r.desc)}
                </div>
            `;
        });
    }
    
    window.searchCurrentResults = results;
    window.lastSearchQuery = query;
    window.lastSearchField = field;
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
        renderSearchResults(window.searchCurrentResults, window.lastSearchQuery || "", window.lastSearchField || "answer");
    }
}

function renderMyBookmarksTab() {
    const isWritten = (currentAppMode === 'written');
    document.getElementById("header-center-title").innerText = isWritten ? "필기 즐겨찾기" : "실기 즐겨찾기";
    const container = document.getElementById("view-renderer");
    
    const bookmarks = getBookmarkedQuestions().filter(b => b.type === currentAppMode);
    
    const backupHtml = `
        <div class="backup-btn-group" style="margin-bottom: 16px;">
            <button class="util-sub-btn" onclick="exportBackupData()">💾 데이터 백업</button>
            <button class="util-sub-btn" onclick="triggerRestoreFileInput()">📂 데이터 복원</button>
            <input type="file" id="backup-file-input" accept=".json" style="display: none;" onchange="importBackupData(event)">
        </div>
    `;

    if (bookmarks.length === 0) {
        container.innerHTML = `
            ${backupHtml}
            <div style="text-align:center; padding-top:40px; color:var(--text-light);">
                <div style="font-size:45px; margin-bottom:15px;">⭐</div>
                <p style="font-size:14px;">현재 모드에 보관된 즐겨찾기가 없습니다.</p>
            </div>
        `;
        return;
    }

    const bookmarkIds = bookmarks.map(b => b.id).filter(id => id !== undefined);
    let startButtonHtml = "";
    if (bookmarkIds.length > 0) {
        startButtonHtml = `
            <button class="nav-control-btn" style="width:100%; margin-bottom: 16px;" onclick="startBookmarkQuiz()">
                해당 항목 모의고사 가동 (${bookmarkIds.length}문항)
            </button>
        `;
    }

    let html = `
        ${backupHtml}
        ${startButtonHtml}
        <p style="font-size:12.5px; color:var(--text-muted); margin-bottom:12px;">보관된 항목 총 ${bookmarks.length}개</p>
    `;
    
    bookmarks.forEach((b, idx) => {
        const modeText = b.type === 'written' ? '[필기]' : '[실기]';
        let cleanDesc = b.desc ? b.desc.replace(/\[cite:\s*[\d,\s]+\]/gi, "").trim() : "";

        let answerDisplay = escapeHtml(b.answer);
        if (b.type === 'written' && b.choices && Array.isArray(b.choices)) {
            const ansIdx = parseInt(b.answer, 10) - 1;
            if (b.choices[ansIdx]) {
                answerDisplay = `${b.answer}번. ${escapeHtml(b.choices[ansIdx])}`;
            }
        }

        html += `
            <div class="log-box-card" style="border-top-color: #f59e0b;">
                <span class="bookmark-toggle-btn" style="position:absolute; top:12px; right:15px;" onclick="removeBookmarkFromTab(${idx})">★</span>
                <div class="source-tag">${modeText} ${b.source}</div>
                <div class="question-title" style="font-size:13.5px; padding-right:25px; white-space: pre-wrap; line-height: 1.55; word-break: break-all;">${escapeHtml(b.text)}</div>
                ${b.image ? `<div style="text-align:center; margin-bottom:10px;"><img src="${b.image}" class="question-img" alt="기출 이미지"></div>` : ''}
                ${b.view ? `<div class="view-content-wrapper">${formatViewHtml(b.view)}</div>` : ''}
                <div style="font-size:13px; color:#10b981; font-weight:bold; margin-top:5px;">정답 용어: ${answerDisplay}</div>
                ${formatExplanationHtml(b.desc)}
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
    if (!area) return;

    const data = getHistoryLogs().filter(log => log.type === currentAppMode);
    
    if (data.length === 0) {
        area.innerHTML = "<p style='color:var(--text-light); font-size:13px;'>저장된 완료 기록이 없습니다.</p>";
        return;
    }
    
    window.historyLogQuestions = window.historyLogQuestions || {};
    let html = "";
    [...data].reverse().forEach(s => {
        const targetQuestions = s.questions || s.wrongs || [];
        window.historyLogQuestions[s.id] = targetQuestions;
        const quizLabel = s.quizLabel || "기출 문제풀이";
        const displayTotal = s.total || targetQuestions.length || 0;

        html += `
            <div class="log-box-card" style="position:relative;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <span style="display:inline-block; padding:3px 8px; font-size:11px; font-weight:bold; border-radius:6px; background-color: var(--bg-sub-box); color: var(--text-title); margin-bottom:4px; border:1px solid var(--border-color);">${quizLabel}</span>
                        <div style="font-size:11px; color:var(--text-muted);">풀이 시점: ${s.date}</div>
                    </div>
                    <button class="header-btn" style="background:#ef4444; border:none; padding:4px 10px; font-size:11px; color:#fff;" onclick="deleteHistoryLog(${s.id})">삭제</button>
                </div>
                <div style="font-size:14.5px; font-weight:bold; margin:6px 0; color:var(--text-title);">최종 점수: ${s.score}점 (총 ${displayTotal}문항)</div>
                <div style="font-size:12.5px; color:#ef4444; font-weight:bold; margin-bottom:8px;">틀린 문제 수: ${s.wrongCount}개</div>
                <button class="nav-control-btn" style="padding:7px; font-size:12px; background-color:var(--primary);" onclick="toggleHistoryWrongList(${s.id})">
                    상세 문항 확인하기
                </button>
                <div id="wrong-container-${s.id}" style="display:none; margin-top:5px;">
                    ${targetQuestions.map((w, idx) => {
                        const isRight = w.isRight !== undefined ? w.isRight : false;
                        const isBookmarked = isQuestionBookmarked(w.text);
                        const starChar = isBookmarked ? "★" : "☆";
                        const modeText = w.type === 'written' ? '[필기]' : '[실기]';
                        let cleanDesc = w.desc ? w.desc.replace(/\[cite:\s*[\d,\s]+\]/gi, "").trim() : "";

                        const realAns = w.realAnswer || w.answer;
                        let answerDisplay = escapeHtml(realAns);
                        if (w.type === 'written' && w.choices && Array.isArray(w.choices)) {
                            const ansIdx = parseInt(realAns, 10) - 1;
                            if (w.choices[ansIdx]) {
                                answerDisplay = `${realAns}번. ${escapeHtml(w.choices[ansIdx])}`;
                            }
                        }

                        return `
                            <div class="history-wrong-item" style="border-left: 4px solid ${isRight ? '#10b981' : '#ef4444'}; padding-left: 10px; margin-bottom: 10px; position: relative;">
                                <span class="bookmark-toggle-btn" style="position: absolute; top: 0; right: 5px; cursor: pointer; font-size: 16px;" onclick="toggleBookmarkFromHistory(${s.id}, ${idx}, this)">${starChar}</span>
                                <div style="font-weight:bold; color:${isRight ? '#10b981' : '#dc2626'}; margin-bottom:3px;">${modeText} ${w.source} [${isRight ? '정답' : '오답'}]</div>
                                <div style="font-weight:bold; color:var(--text-title); margin-bottom:4px; white-space: pre-wrap; line-height: 1.5; word-break: break-all;">문제: ${escapeHtml(w.text)}</div>${w.image ? `<div style="text-align:center; margin-top:8px; margin-bottom:8px;"><img src="${w.image}" class="question-img" alt="기출 이미지"></div>` : ''}
                                ${w.view ? `<div class="view-content-wrapper">${formatViewHtml(w.view)}</div>` : ''}
                                <div style="font-size:12.5px; margin:2px 0;">작성 답안: <span style="font-weight:bold; color:${isRight ? '#10b981':'#dc2626'}">${escapeHtml(w.userAnswer) || "미입력"}</span></div>
                                <div style="font-size:12.5px; margin:2px 0; color:#10b981; font-weight:bold;">정답 용어: ${answerDisplay}</div>
                                ${formatExplanationHtml(w.desc)}
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
    if (area) {
        area.style.display = area.style.display === "none" ? "block" : "none";
    }
}

function startQuizTimer(isNewSession) {
    clearInterval(quizTimerInterval);
    if (isNewSession) {
        if (currentAppMode === 'written') {
            remainingTimeSeconds = currentCertType === 'net2' ? 60 * 60 : 150 * 60; 
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
    if(modal) modal.style.display = "flex";
};

window.closeQuestionNavModal = function(event) {
    const modal = document.getElementById("q-nav-modal");
    if(modal) modal.style.display = "none";
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
        selectedYear = "all";
    }

    let resumeState = null;
    if (selectedYear === 'sequential' && localStorage.getItem(getSeqSaveKey())) {
        const savedState = JSON.parse(localStorage.getItem(getSeqSaveKey()));
        if (savedState.activeSessionType === currentAppMode) {
            const shouldResume = customTargetId ? true : confirm("이전에 멈춤 기록이 존재합니다. 이어서 풀이하시겠습니까? (취소 시 1번부터 시작)");
            if (shouldResume) {
                resumeState = savedState;
            } else {
                localStorage.removeItem(getSeqSaveKey());
            }
        } else {
            localStorage.removeItem(getSeqSaveKey());
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
        const res = await fetch(getApiBase() + '/new', { 
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

        logUserAction("START_EXAM", { mode: currentAppMode, year: selectedYear, subject: customSubject || "전체" });
        history.pushState({ screen: 'exam', mode: currentAppMode, cert: currentCertType }, '');

        if (resumeState) {
            currentQuizIndex = Math.min(resumeState.currentQuizIndex || 0, sessionQuizData.length - 1);
            savedUserAnswers = resumeState.savedUserAnswers || {};
            remainingTimeSeconds = resumeState.remainingTimeSeconds || (currentAppMode === 'written' ? (currentCertType === 'net2' ? 60 * 60 : 150 * 60) : sessionQuizData.length * 90);
            
            if (customTargetId) {
                const foundIdx = sessionQuizData.findIndex(item => item.id === parseInt(customTargetId, 10));
                if (foundIdx !== -1) currentQuizIndex = foundIdx;
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
        if (/^\[.*\]$/.test(line) || line.includes("패턴 목록") || line.includes("보기 목록")) continue;
        if (line.includes("기입") || line.includes("선택하여") || line.includes("쓰시오") || 
            line.includes("입력란") || line.includes("번 칸") || line.includes("양식에") || 
            line.includes("보기 중에서") || line.includes("설명식") || line.includes("따라")) continue;
        
        if (line.includes("패턴:") || line.includes("패턴 :")) {
            const parts = line.split(":");
            if (parts.length > 1) line = parts[1].trim();
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
        if (text.length > 1) {
            text = text.replace(/^[㉠-㉾①-⑮]/, '');
            text = text.replace(/^[0-9a-zA-Zㄱ-ㅎ]\s*[\.\,\)\:]\s*/, '');
            text = text.replace(/^\([0-9a-zA-Zㄱ-ㅎ㉠-㉾①-⑮]+\)\s*/, '');
            text = text.trim();
        }

        if (!text || text.length > 35 || text.includes("~") || text.includes(":") || text.includes("영역") ||
            text === "생성 패턴" || text === "구조 패턴" || text === "행위 패턴" ||
            text.includes("패턴 목록") || text.includes("목록]") || text.endsWith("]") ||
            text.includes("번 칸:") || text.includes("입력란:")) continue;

        cleanItems.push(text);
    }
    
    cleanItems = [...new Set(cleanItems)];
    if (cleanItems.length === 0) return "";
    
    let html = `
        <div class="choices-guide-wrap" style="margin-top: 10px; margin-bottom: 6px;">
            <div style="font-size: 11.5px; font-weight: bold; color: var(--primary); margin-bottom: 4px; display: flex; align-items: center; gap: 4px;">
                [빠른 정답 입력]
            </div>
            <div class="choices-container" style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: flex-start;"> 
        `;
    
    cleanItems.forEach(item => {
        const safeClickVal = item.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        html += `
            <button type="button" class="choice-badge" style="padding: 6px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 20px; font-size: 12.5px; color: var(--primary); cursor: pointer; font-weight: bold; outline: none; transition: background 0.2s;" 
                onclick="handleChoiceClick('${safeClickVal}')">
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
    const questionTarget = document.getElementById("question-focus-target");
    if (questionTarget) questionTarget.focus();

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

    if (activeSessionYear === 'sequential') {
        history.replaceState(null, '', `?mode=${currentAppMode}&year=sequential&id=${q.id}&cert=${currentCertType || 'qnet'}`);
    } else {
        history.replaceState(null, '', `?mode=${currentAppMode}&id=${q.id}&cert=${currentCertType || 'qnet'}`);
    }

    const modeLabel = q.type === 'written' ? '객관식 필기 모드' : '주관식 실기 모드';
    document.getElementById("header-center-title").innerText = modeLabel;
    const container = document.getElementById("view-renderer");
    
    const isBookmarked = isQuestionBookmarked(q.text);
    const starChar = isBookmarked ? "★" : "☆";
    let delimiter = (q.answer && q.answer.includes(" / ")) ? " / " : ",";
    
    if (activeSessionYear === 'sequential') {
        const saveState = {
            activeSessionYear: activeSessionYear,
            activeSessionType: activeSessionType,
            currentQuizIndex: currentQuizIndex,
            savedUserAnswers: savedUserAnswers,
            remainingTimeSeconds: remainingTimeSeconds 
        };
        localStorage.setItem(getSeqSaveKey(), JSON.stringify(saveState));
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
        <div class="question-main-card">
            <div class="step-panel-header">
                <div class="step-label clickable" onclick="openQuestionNavModal()">문항 이동: ${currentQuizIndex + 1} / ${sessionQuizData.length} ▼</div>
                <div id="quiz-timer-display" class="timer-display"></div>
                <span class="bookmark-toggle-btn" id="bookmark-icon" onclick="handleBookmarkClick()">${starChar}</span>
            </div>
            <div class="source-tag">${q.source}</div>
            
            ${formatQuestionView(q.text)}
            
            ${q.image ? `<div style="text-align:center; margin-bottom:12px;"><img src="${q.image}" class="question-img" alt="기출 이미지"></div>` : ''}
            ${q.view ? `<div class="view-content-wrapper">${formatViewHtml(q.view)}</div>` : ''}
        </div>
        
        ${choicesHtml}
        ${inputHtml}
        
        <div id="instant-reveal-area"></div>

        <div class="action-toggle-card" id="main-action-trigger-card" onclick="toggleInstantFeedbackReveal(${q.id})">
            정답 확인
        </div>

        <div class="nav-btn-group">
            <button class="nav-control-btn" style="background-color:#64748b;" onclick="moveStep(-1)" ${currentQuizIndex === 0 ? 'disabled' : ''}>← Prev</button>
            <button class="nav-control-btn" onclick="moveStep(1)">
                ${currentQuizIndex === sessionQuizData.length - 1 ? '최종 채점 및 제출' : 'Next →'}
            </button>
        </div>
        
        ${modalHtml}
    `;
    
    container.innerHTML = html;
    container.scrollTop = 0;
    
    updateTimerDisplay();
    if (revealedAnswers[q.id]) showAnswerBoxInline(q, revealedAnswers[q.id]);
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
            const res = await fetch(getApiBase() + '/check-answer', {
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
    
    let answerDisplay = escapeHtml(data.answer);
    if (q.type === 'written' && data.choices) {
        const ansIdx = parseInt(data.answer, 10) - 1;
        if (data.choices[ansIdx]) {
            answerDisplay = `${data.answer}번. ${escapeHtml(data.choices[ansIdx])}`;
        }
    }

    panelArea.innerHTML = `
        <div class="instant-feedback-panel">
            <div style="font-weight:bold; color:#10b981; margin-bottom:10px; font-size:14.5px;">💡 출제 정답: ${answerDisplay}</div>
            ${formatExplanationHtml(data.desc)}
        </div>
    `;
    
    const actionCard = document.getElementById("main-action-trigger-card");
    if (actionCard) {
        actionCard.innerText = "확인 완료";
        actionCard.style.backgroundColor = "#16a34a";
    }

    logUserAction("INSTANT_CHECK_ANSWER", { questionId: q.id, mode: q.type });

    setTimeout(() => {
        if (actionCard) actionCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
}

function hideAnswerBoxInline() {
    const panelArea = document.getElementById("instant-reveal-area");
    if (panelArea) panelArea.innerHTML = "";
    
    const actionCard = document.getElementById("main-action-trigger-card");
    if (actionCard) {
        actionCard.innerText = "정답 확인";
        actionCard.style.backgroundColor = "var(--bg-header)";
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
    if (e.key === 'Enter') moveStep(1);
}

function handleBookmarkClick() {
    const q = sessionQuizData[currentQuizIndex];
    if (q) toggleBookmarkStatus(q);
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
        const res = await fetch(getApiBase() + '/submit', {
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
        
        localStorage.removeItem(getSeqSaveKey());
        saveHistoryToLocal(result);
        logUserAction("SUBMIT_EXAM", { mode: activeSessionType, score: result.score, isPassed: result.isPassed });
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
    const calculatedTotal = result.total || (result.reviewData ? result.reviewData.length : (sessionQuizData ? sessionQuizData.length : 0));

    const newLog = {
        id: Date.now(),
        date: new Date().toLocaleString('ko-KR'),
        type: activeSessionType,
        quizLabel: result.quizLabel || activeQuizLabel || "기출 문제풀이",
        score: result.score,
        total: calculatedTotal,
        wrongCount: result.reviewData.filter(r => !r.isRight).length,
        questions: questions,
        solvedIds: currentSolvedIds
    };
    
    history.push(newLog);
    localStorage.setItem(getHistoryKey(), JSON.stringify(history));
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
                <h2 style="margin: 0 0 6px 0; font-size: 22px; font-weight: bold;">축하합니다! 합격입니다!</h2>
                <p style="margin: 0; font-size: 15px; font-weight: bold;">최종 점수: ${finalScore}점 / 100점 만점</p>
                <p style="margin: 4px 0 0 0; font-size: 12px; opacity: 0.9;">(합격 기준: 60점 이상 및 과락 미발생)</p>
            </div>
        `;
    } else {
        let failReasonText = "평균 점수 60점 미달";
        if (isGwarak) failReasonText = `과락 발생 [${gwarakSubjects.join(", ")}]`;

        resultBannerHtml = `
            <div style="background: linear-gradient(135deg, #ef4444, #dc2626); color: #ffffff; padding: 24px 18px; border-radius: 12px; margin-bottom: 16px; text-align: center;">
                <div style="font-size: 40px; margin-bottom: 5px;">💪</div>
                <h2 style="margin: 0 0 5px 0; font-size: 22px;">아쉽습니다! 불합격입니다</h2>
                <p style="margin: 0; font-size: 15px; font-weight: bold;">최종 점수: ${finalScore}점 / 100점 만점</p>
                <p style="margin: 6px 0 0 0; font-size: 12px; background: rgba(0,0,0,0.2); padding: 5px; border-radius: 6px;">불합격 사유: ${failReasonText}</p>
            </div>
        `;
    }
    
    let html = `
        <div style="padding: 10px 0;">
            ${resultBannerHtml}
            <button class="nav-control-btn" style="width:100%; margin-bottom:16px;" onclick="loadMainDashboard()">대시보드 메인으로 복귀</button>
        </div>
        <h4 style="color:var(--text-title); border-bottom:2px solid var(--border-color); padding-bottom:5px; margin-bottom:12px;">문항별 상세 리뷰</h4>
    `;
    
    result.reviewData.forEach((r, idx) => {
        const isBookmarked = isQuestionBookmarked(r.text);
        const starChar = isBookmarked ? "★" : "☆";
        const modeText = r.type === 'written' ? '[필기]' : '[실기]';
        
        let answerDisplay = escapeHtml(r.realAnswer);
        if (r.type === 'written' && r.choices) {
            const ansIdx = parseInt(r.realAnswer, 10) - 1;
            if (r.choices[ansIdx]) answerDisplay = `${r.realAnswer}번. ${escapeHtml(r.choices[ansIdx])}`;
        }

        let scoreBadge = "";
        if (r.type === 'practical') {
            scoreBadge = `<span style="font-size:12px; font-weight:bold; color:${r.earnedScore > 0 ? '#10b981' : '#dc2626'}; float:right;">획득: ${r.earnedScore}점 / ${r.maxScore}점</span>`;
        }

        let cleanDesc = r.desc ? r.desc.replace(/\[cite:\s*[\d,\s]+\]/gi, "").trim() : "";

        html += `
            <div class="log-box-card" style="border-top-color: ${r.isRight ? '#10b981' : '#ef4444'}; position: relative;">
                <span class="bookmark-toggle-btn" style="position: absolute; top: 12px; right: 15px; cursor: pointer; font-size: 18px;" onclick="toggleBookmarkFromReview(${idx}, this)">${starChar}</span>
                <div class="source-tag">${idx + 1}번 | ${modeText} 출처: ${r.source} [${r.isRight ? 'PASS' : 'FAIL'}] ${scoreBadge}</div>
                <div class="question-title" style="font-size:13.5px; margin-bottom:8px; white-space: pre-wrap; line-height: 1.5; word-break: break-all;">문제: ${escapeHtml(r.text)}</div>
                ${r.image ? `<div style="text-align:center; margin-bottom:10px;"><img src="${r.image}" class="question-img" alt="기출 이미지"></div>` : ''}
                ${r.view ? `<div class="view-content-wrapper">${formatViewHtml(r.view)}</div>` : ''}
                <div style="font-size:12.5px; margin:2px 0;">작성 답안: <span style="font-weight:bold; color:${r.isRight ? '#10b981' : '#dc2626'}">${escapeHtml(r.userAnswer) || "미입력"}</span></div>
                <div style="font-size:12.5px; margin:2px 0; color:#10b981; font-weight:bold;">정답 용어: ${answerDisplay}</div>
                ${formatExplanationHtml(r.desc)}
            </div>
        `;
    });
    
    view.innerHTML = html;
    view.scrollTop = 0;
}

function exitToDashboard(fromPopstate = false) {
    if (activeSessionId) {
        const confirmMessage = (activeSessionYear === 'sequential')
            ? "진행 상황이 저장되었습니다. 메인 화면으로 돌아가시겠습니까?"
            : "시험을 중단하고 메인 화면으로 돌아가시겠습니까?";

        if (confirm(confirmMessage)) {
            clearInterval(quizTimerInterval);
            activeSessionId = null;
            activeSessionYear = null;
            activeSessionType = null;
            loadMainDashboard(fromPopstate);
        } else {
            if (fromPopstate) {
                history.pushState({ screen: 'exam', mode: currentAppMode, cert: currentCertType }, '');
            }
        }
    } else if (globalTabState !== 'all') {
        switchMainTab('all', fromPopstate);
    } else {
        const centerTitle = document.getElementById("header-center-title")?.innerText;
        if (centerTitle && centerTitle.includes("채점 분석 리포트")) {
            loadMainDashboard(fromPopstate);
        } else {
            currentAppMode = null;
            loadModeSelectionScreen(fromPopstate);
        }
    }
}

// 브라우저 및 스마트폰 물리/제스처 뒤로가기(popstate) 핸들러 등록
window.addEventListener('popstate', (e) => {
    exitToDashboard(true);
});

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
    if (!message || message.trim() === "") return;
    
    const fingerprint = generateDeviceFingerprint();
    const requestData = {
        appMode: currentAppMode || "common",
        message: message.trim(),
        fingerprint: fingerprint
    };

    fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData)
    })
    .then(res => res.json().then(data => ({ status: res.status, body: data })))
    .then(obj => {
        if (obj.status === 200 && obj.body.success) {
            logUserAction("FEEDBACK_SENT", { mode: currentAppMode });
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
    initTheme();
    const urlParams = new URLSearchParams(window.location.search);
    const targetId = urlParams.get('id');
    const mode = urlParams.get('mode');
    const year = urlParams.get('year');

    const cert = urlParams.get('cert');
    if (targetId) {
        currentCertType = (cert === 'net2') ? 'net2' : 'qnet';
        currentAppMode = (mode === 'written') ? 'written' : 'practical';
        globalTabState = 'all';
        updateBottomTabUI();
        updateHeaderDDayBadge();
        if (year === 'sequential') {
            triggerNewQuizSession('sequential', null, null, parseInt(targetId, 10));
        } else {
            startSingleQuestionQuiz(parseInt(targetId, 10));
        }
    } else {
        loadModeSelectionScreen();
    }
};