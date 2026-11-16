// 텍스트 정적 파일(html/js/css/svg)을 메모리에 두고 gzip 압축본을 미리 만들어 보낸다.
// 요청마다 압축하지 않으므로 CPU를 쓰지 않고, 전송량은 1/3~1/4로 준다. 파일이 바뀌면 다음 요청 때 다시 만든다.
// 캐시 정책:
//   - html: no-cache (매번 새 버전인지 확인. 배포 후 옛 화면이 남지 않게)
//   - ?v=버전 이 붙은 js/css: 1년 보관(버전이 바뀌면 주소가 바뀐다)
//   - 그 외: 하루 보관 후 확인
// 처리하지 않는 파일(이미지 등)은 다음 미들웨어(express.static)로 넘긴다.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.svg': 'image/svg+xml'
};

function cacheControl(ext, req) {
    if (ext === '.html') return 'no-cache';
    if (req.query && req.query.v) return 'public, max-age=31536000, immutable';
    return 'public, max-age=86400';
}

/**
 * @param {string} rootDir 파일을 찾을 폴더
 * @param {object} [opts] { files: { '/요청경로': '파일 이름' } } 지정하면 그 파일만 보낸다
 */
function createStaticCache(rootDir, opts) {
    const root = path.resolve(rootDir);
    const fileMap = opts && opts.files ? opts.files : null;
    const cache = new Map(); // 절대 경로 → { mtimeMs, size, raw, gz, etag, type }

    return function staticCache(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();

        let rel;
        if (fileMap) {
            rel = fileMap[req.path];
            if (!rel) return next();
        } else {
            try {
                rel = decodeURIComponent(req.path);
            } catch (e) {
                return next();
            }
            if (rel === '/' || rel === '') rel = '/index.html';
        }

        const ext = path.extname(rel).toLowerCase();
        if (!TYPES[ext]) return next();
        const full = path.resolve(root, '.' + path.sep + rel.replace(/^[/\\]+/, ''));
        if (!full.startsWith(root + path.sep)) return next(); // 폴더 밖 접근 차단
        if (path.basename(full).startsWith('.')) return next(); // 숨김 파일 제외

        let stat;
        try {
            stat = fs.statSync(full);
        } catch (e) {
            return next();
        }
        if (!stat.isFile()) return next();

        let entry = cache.get(full);
        if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
            const raw = fs.readFileSync(full);
            entry = {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                raw,
                gz: zlib.gzipSync(raw, { level: 9 }),
                etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"',
                type: TYPES[ext]
            };
            cache.set(full, entry);
        }

        res.setHeader('Content-Type', entry.type);
        res.setHeader('ETag', entry.etag);
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Cache-Control', cacheControl(ext, req));

        const inm = req.headers['if-none-match'];
        if (inm && inm.split(',').map(s => s.trim().replace(/^W\//, '')).includes(entry.etag)) {
            res.statusCode = 304;
            return res.end();
        }

        const useGzip = /\bgzip\b/i.test(req.headers['accept-encoding'] || '') && entry.gz.length < entry.raw.length;
        const body = useGzip ? entry.gz : entry.raw;
        if (useGzip) res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', body.length);
        if (req.method === 'HEAD') return res.end();
        res.end(body);
    };
}

module.exports = { createStaticCache };
