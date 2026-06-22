const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..')

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('LocalControlServer ships instead of removed DashboardServer', () => {
    assert.equal(fs.existsSync(path.join(root, 'src/core/DashboardServer.ts')), false)
    assert.equal(fs.existsSync(path.join(root, 'src/core/LocalControlServer.ts')), true)
    assert.doesNotMatch(read('src/index.ts'), /DashboardServer|startDashboard|stopDashboard/)
    assert.match(read('src/index.ts'), /LocalControlServer|runControlPanelLoop/)
    assert.match(read('tsconfig.json'), /src\/core\/DashboardServer\.ts/)
})

test('control panel API never exposes account passwords', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-panel-'))
    const prevCwd = process.cwd()

    try {
        process.chdir(tmpDir)

        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
        fs.mkdirSync(path.join(tmpDir, 'dist', 'control-panel'), { recursive: true })
        fs.writeFileSync(
            path.join(tmpDir, 'dist', 'control-panel', 'index.html'),
            '<!DOCTYPE html><html><body>test</body></html>'
        )

        fs.writeFileSync(
            path.join(tmpDir, 'src', 'accounts.json'),
            JSON.stringify(
                [
                    {
                        email: 'test@example.com',
                        password: 'super-secret',
                        totpSecret: 'ABCD1234',
                        enabled: true,
                        geoLocale: 'US',
                        langCode: 'en',
                        recoveryEmail: '',
                        proxy: {
                            proxyAxios: false,
                            url: '',
                            port: 0,
                            username: '',
                            password: 'proxy-secret'
                        },
                        saveFingerprint: { mobile: false, desktop: false }
                    }
                ],
                null,
                4
            )
        )

        fs.writeFileSync(
            path.join(tmpDir, 'src', 'config.json'),
            JSON.stringify(
                {
                    baseURL: 'https://rewards.bing.com',
                    sessionPath: 'sessions',
                    headless: true,
                    runOnZeroPoints: false,
                    clusters: 1,
                    errorDiagnostics: false,
                    workers: {
                        doDailySet: true,
                        doSpecialPromotions: false,
                        doMorePromotions: false,
                        doAppPromotions: false,
                        doDesktopSearch: true,
                        doMobileSearch: false,
                        doDailyCheckIn: false,
                        doReadToEarn: false,
                        doDailyStreak: false,
                        doRedeemGoal: false,
                        doDashboardInfo: true,
                        doClaimPoints: false,
                        enforceCoreStreakProtectionGate: false
                    },
                    searchOnBingLocalQueries: true,
                    globalTimeout: '30sec',
                    searchSettings: {
                        scrollRandomResults: true,
                        clickRandomResults: true,
                        parallelSearching: false,
                        searchDelay: { min: 3000, max: 6000 },
                        readDelay: { min: 2000, max: 5000 }
                    },
                    debugLogs: false,
                    proxy: { proxyAxios: false, url: '', port: 0, username: '', password: '' },
                    consoleLogFilter: { error: true, warn: true, info: true, debug: false },
                    webhook: { enabled: false, url: '' },
                    controlPanel: { enabled: true, port: 0, runOnStartup: false }
                },
                null,
                4
            )
        )

        const { reloadConfig } = require(path.join(root, 'dist/helpers/ConfigLoader.js'))
        const { LocalControlServer } = require(path.join(root, 'dist/core/LocalControlServer.js'))

        const config = reloadConfig()
        const bot = {
            appVersion: 'test',
            config,
            dashboardRunState: 'idle',
            dashboardStopRequested: false,
            localRunRequested: false,
            localRunAccountSelector: null,
            localRunAccountList: null,
            dashboardEvents: [],
            logger: { info() {}, warn() {}, error() {}, debug() {} },
            applyConfig(next) {
                this.config = next
            },
            async reloadAccounts() {}
        }

        const server = new LocalControlServer(bot)
        const { port, token } = await server.start()

        const accountsRes = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
            headers: { Authorization: `Bearer ${token}` }
        })
        assert.equal(accountsRes.status, 200)
        const accountsBody = await accountsRes.json()
        const serialized = JSON.stringify(accountsBody)
        assert.doesNotMatch(serialized, /super-secret/)
        assert.doesNotMatch(serialized, /proxy-secret/)
        assert.doesNotMatch(serialized, /ABCD1234/)
        assert.equal(accountsBody.accounts[0].hasPassword, true)

        const badPatch = await fetch(`http://127.0.0.1:${port}/api/config`, {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ webhook: { enabled: true } })
        })
        assert.equal(badPatch.status, 500)

        const noAuth = await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST' })
        assert.equal(noAuth.status, 401)

        bot.localRunAccountList = null
        bot.localRunRequested = false
        const runRes = await fetch(`http://127.0.0.1:${port}/api/run`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ accounts: ['test@example.com', 'missing@example.com'] })
        })
        assert.equal(runRes.status, 200)
        assert.equal(bot.localRunRequested, true)
        assert.deepEqual(bot.localRunAccountList, ['test@example.com', 'missing@example.com'])

        await server.stop()
    } finally {
        process.chdir(prevCwd)
        fs.rmSync(tmpDir, { recursive: true, force: true })
    }
})

test('LocalControlServer binds to localhost only', () => {
    const source = read('src/core/LocalControlServer.ts')
    assert.match(source, /listen\(port,\s*'127\.0\.0\.1'/)
})

test('public docs distinguish OSS local panel from Core remote dashboard', () => {
    const docs = read('docs/dashboard.md')
    assert.match(docs, /official Core feature/i)
    assert.match(docs, /Local HTTP control panel/)
    assert.match(read('docs/local-control-panel.md'), /127\.0\.0\.1/)
})
