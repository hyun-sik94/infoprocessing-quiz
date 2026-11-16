// 관리자 비밀번호를 잊었을 때 서버에서 실행한다: node scripts/reset-admin-password.js
// 관리자 화면에서 바꾼 비밀번호(feedback.db의 admin_settings)를 지운다.
// 그러면 환경변수 ADMIN_PASSWORD가 있으면 그 값, 없으면 초기 비밀번호로 돌아가고,
// 초기 비밀번호로 로그인하면 새 비밀번호로 바꾸기 전까지 다른 관리자 기능은 막힌다.
// 실행 중인 서버는 재시작하지 않아도 바로 반영된다(요청마다 DB를 읽는다).
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'feedback.db');
const db = new Database(dbPath);

const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'admin_settings'").get();
if (!hasTable) {
    console.log('저장된 관리자 비밀번호가 없습니다. (admin_settings 테이블 없음)');
    process.exit(0);
}

const info = db.prepare("DELETE FROM admin_settings WHERE key = 'password_hash'").run();
db.close();
console.log(info.changes
    ? '관리자 비밀번호를 초기화했습니다. 초기 비밀번호(또는 ADMIN_PASSWORD 환경변수)로 로그인한 뒤 새 비밀번호를 정해 주세요.'
    : '저장된 관리자 비밀번호가 없습니다. 이미 초기 비밀번호(또는 ADMIN_PASSWORD 환경변수) 상태입니다.');
