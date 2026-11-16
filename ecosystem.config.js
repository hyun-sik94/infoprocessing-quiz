// pm2 실행 설정 (운영 서버: OCI VM.Standard.E2.1.Micro, 1 OCPU, 메모리 1GB)
// 처음 한 번: pm2 delete quiz-app && pm2 start ecosystem.config.js && pm2 save
// 이후 배포(deploy.yml의 pm2 reload quiz-app)는 이 설정을 그대로 쓴다.
module.exports = {
    apps: [{
        name: 'quiz-app',
        script: 'server.js',
        cwd: __dirname,
        // 시험 세션을 프로세스 메모리에 두므로 프로세스는 1개여야 한다(cluster 금지). CPU도 1개다.
        instances: 1,
        exec_mode: 'fork',
        // 1GB 서버: V8 힙 상한을 정해 일찍 GC하게 하고, 혹시 메모리가 새면 400MB에서 재시작한다.
        node_args: '--max-old-space-size=256',
        max_memory_restart: '400M',
        env: {
            NODE_ENV: 'production'
            // PORT(기본 3000), ADMIN_PORT(기본 3100), ADMIN_HOST(기본 127.0.0.1)는 서버 코드 기본값을 쓴다.
            // 관리자 비밀번호는 여기에 쓰지 않는다(관리자 화면에서 정한다).
        },
        kill_timeout: 5000,
        time: true
    }]
};
