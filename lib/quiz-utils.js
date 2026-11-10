// 두 서버(server.js, controllers/net2.controller.js)가 공유하는 출제·채점 유틸리티

/** Fisher-Yates 셔플 (원본 불변). sort(() => Math.random() - 0.5) 방식은 결과가 한쪽으로 치우친다. */
function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/** 문제 + 보기가 완전히 같은 문항(회차 간 재출제)은 하나만 남긴다. 앞쪽 문항을 유지한다. */
function dedupeQuestions(questions) {
    const seen = new Set();
    return questions.filter(q => {
        const choices = Array.isArray(q.choices) ? q.choices.map(c => String(c).replace(/\s+/g, '')).sort().join('|') : '';
        const key = String(q.text || '').replace(/\s+/g, ' ').trim() + '||' + String(q.view || '').replace(/\s+/g, ' ').trim() + '||' + choices;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** 즐겨찾기 요청 형식 정규화: 배열 또는 { ids: [...] } 객체를 모두 id 배열로 */
function normalizeBookmarkIds(bookmarkIds) {
    if (Array.isArray(bookmarkIds)) return bookmarkIds;
    if (bookmarkIds && Array.isArray(bookmarkIds.ids)) return bookmarkIds.ids;
    return [];
}

/** 회차(연도) 풀이 이어풀기 요청인지: year가 특수 값이 아니고, 저장된 문항 id 배열이 있을 때 */
const NON_ROUND_YEARS = ['sequential', 'subject', 'bookmark', 'target', 'cbt', 'all'];
function isRoundResume(year, resumeIds) {
    return typeof year === 'string' && year.length > 0 && !NON_ROUND_YEARS.includes(year)
        && Array.isArray(resumeIds) && resumeIds.length > 0 && resumeIds.length <= 2000
        && resumeIds.every(id => Number.isInteger(id));
}

// ──────────────────────────────────────────────
// 실기 채점
// ──────────────────────────────────────────────
const norm = s => String(s).trim().toLowerCase();
const collapse = s => norm(s).replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ');

// 정답의 구분자: 쉼표, 그리고 앞뒤 공백이 있는 " / ". 'MC/DC' 같은 붙은 슬래시는 한 단어로 본다.
function splitReal(s) {
    return String(s).split(/\s*,\s*|\s+\/\s+/).map(norm).filter(p => p.length > 0);
}

/**
 * 정답 문자열 → 채점 명세
 *  - 일반:           "a, b"                      → 부분 목록 [[a],[b]]
 *  - 부분별 대체표기:  "A|a, B|b"                  → [[A,a],[B,b]]  (모든 쉼표 조각에 | 가 있을 때)
 *  - 전체 대체표기:    "③, ④|3, 4"                 → 세트 2개 중 가장 잘 맞는 것
 *  - 단일 문장(SQL):  입력칸이 1개이고 SELECT/INSERT/... 로 시작하며 쉼표가 있으면 쉼표로 쪼개지 않는다.
 * 반환: { sets: [ [ [대체표기...], ... ] ] }
 */
function parseReal(real, inputCount) {
    const r = String(real || '').trim();
    if (r.includes('|')) {
        const raw = r.split(/\s*,\s*/);
        if (raw.every(x => x.includes('|'))) {
            return { sets: [raw.map(x => x.split('|').map(norm).filter(Boolean))] };
        }
        return { sets: r.split('|').map(s => splitReal(s).map(p => [p])).filter(set => set.length > 0) };
    }
    if ((!inputCount || inputCount <= 1) && r.includes(',') && /^\s*(select|insert|update|delete|create|alter|drop)\b/i.test(r)) {
        return { sets: [[[collapse(r)]]], single: true };
    }
    return { sets: [splitReal(r).map(p => [p])] };
}

function scorePractical(userAns, realAns, inputCount) {
    const spec = parseReal(realAns, inputCount);
    const u = String(userAns || '').trim();
    const hasSlashReal = spec.sets.some(set => set.some(alts => alts.some(a => a.includes('/'))));
    let userParts;
    if (spec.single) {
        userParts = [collapse(u)];
    } else {
        // 구 버전과의 호환: 정답에 붙은 슬래시가 없으면 사용자의 '/'도 구분자로 허용
        const re = hasSlashReal ? /\s*,\s*|\s+\/\s+/ : /[,/]/;
        userParts = u.split(re).map(norm).filter(p => p.length > 0);
    }

    let best = { matched: 0, total: 0 };
    for (const set of spec.sets) {
        const total = set.length;
        let matched = 0;
        set.forEach(alts => { if (alts.some(a => userParts.includes(a))) matched++; });
        const ratio = total > 0 ? matched / total : 0;
        const bestRatio = best.total > 0 ? best.matched / best.total : 0;
        if (best.total === 0 || ratio > bestRatio) best = { matched, total };
    }

    const { matched, total } = best;
    let earned = 0, isRight = false;
    if (total > 0 && matched === total) { isRight = true; earned = 5; }
    else if (matched > 0 && total > 1) { earned = Math.floor((matched / total) * 5 * 10) / 10; }
    return { isRight, earned, matched, total };
}

module.exports = { shuffle, dedupeQuestions, normalizeBookmarkIds, isRoundResume, scorePractical };
