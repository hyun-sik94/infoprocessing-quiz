// 문제 데이터(JSON) 메모리 캐시.
// 요청마다 파일을 다시 읽고 해석하지 않도록 한 번만 읽어 두고, 모든 요청과 세션이 같은 객체를 공유한다.
// 파일이 바뀌면(수정 시각·크기) 다음 요청 때 다시 읽는다. 배포 때는 서버가 재시작되므로 항상 새 데이터를 쓴다.
// 공유 객체가 실수로 바뀌지 않도록 얼린다(Object.freeze). 응답용으로 고칠 때는 반드시 복사본을 만든다.
const fs = require('fs');

const cache = new Map(); // 파일 경로 → { mtimeMs, size, questions, byId, memo }

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(deepFreeze);
    }
    return value;
}

function load(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (e) {
        cache.delete(filePath);
        return null;
    }
    const entry = cache.get(filePath);
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) return entry;

    const questions = deepFreeze(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    const fresh = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        questions,
        byId: new Map(questions.map(q => [q.id, q])),
        memo: new Map()
    };
    cache.set(filePath, fresh);
    return fresh;
}

/** 문제 배열(읽기 전용). 파일이 없으면 null */
function getQuestions(filePath) {
    const entry = load(filePath);
    return entry ? entry.questions : null;
}

/** id → 문제 Map(읽기 전용). 파일이 없으면 null */
function getQuestionMap(filePath) {
    const entry = load(filePath);
    return entry ? entry.byId : null;
}

/** 데이터에서 계산한 값(회차 목록 등)을 데이터가 바뀔 때까지 기억한다 */
function memoize(filePath, key, compute) {
    const entry = load(filePath);
    if (!entry) return null;
    if (!entry.memo.has(key)) entry.memo.set(key, compute(entry.questions));
    return entry.memo.get(key);
}

module.exports = { getQuestions, getQuestionMap, memoize };
