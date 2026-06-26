const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const { buildAnalyticsReport, saveAnalyticsGoal } = require('../dist/helpers/AccountAnalyticsLedger')
const { saveAccountDashboardSnapshot } = require('../dist/helpers/AccountDashboardSnapshotLedger')

function sampleAccount(email) {
    return {
        email,
        password: 'secret',
        enabled: true,
        geoLocale: 'US',
        langCode: 'en',
        recoveryEmail: '',
        proxy: {
            proxyAxios: false,
            url: '',
            port: 0,
            username: '',
            password: ''
        },
        saveFingerprint: { mobile: false, desktop: false }
    }
}

function writeRunLine(cwd, dayKey, entry) {
    const dir = path.join(cwd, '.msrb', 'account-runs')
    fs.mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ ...entry, email: entry.email.toLowerCase() }) + '\n'
    fs.appendFileSync(path.join(dir, `${dayKey}.jsonl`), line, 'utf8')
}

test('buildAnalyticsReport aggregates runs, goals, and account rows', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-analytics-report-'))
    const prevCwd = process.cwd()

    try {
        process.chdir(cwd)
        fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
        fs.writeFileSync(
            path.join(cwd, 'src', 'accounts.json'),
            JSON.stringify([
                sampleAccount('alpha@example.com'),
                sampleAccount('beta@example.com')
            ])
        )

        const today = new Date().toISOString().slice(0, 10)
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

        writeRunLine(cwd, today, {
            email: 'alpha@example.com',
            success: true,
            completedAt: new Date().toISOString(),
            collectedPoints: 120,
            level: 'Level 2'
        })
        writeRunLine(cwd, today, {
            email: 'beta@example.com',
            success: true,
            completedAt: new Date().toISOString(),
            collectedPoints: 80,
            level: 'Level 1'
        })
        writeRunLine(cwd, yesterday, {
            email: 'alpha@example.com',
            success: true,
            completedAt: new Date(Date.now() - 86400000).toISOString(),
            collectedPoints: 100,
            level: 'Level 2'
        })

        saveAccountDashboardSnapshot(
            'alpha@example.com',
            {
                userName: 'Alpha',
                level: 'Level 2',
                levelKey: '2',
                availablePoints: 2200,
                readyToClaimPoints: 0,
                claimEntries: [],
                hasClaimEntryExpiringSoon: false,
                todayPoints: 120,
                streakDays: 2,
                dailySetCompleted: 2,
                dailySetTotal: 3
            },
            cwd
        )

        saveAnalyticsGoal({ pointsTarget: 6500, periodDays: 30, label: 'Monthly push' }, cwd)

        const report = buildAnalyticsReport(cwd)

        assert.equal(report.goal?.pointsTarget, 6500)
        assert.equal(report.summary.totalCollected, 300)
        assert.equal(report.summary.enabledAccounts, 2)
        assert.equal(report.summary.activeAccounts, 2)
        assert.equal(report.accounts.length, 2)
        assert.equal(report.accounts[0].email, 'alpha@example.com')
        assert.equal(report.accounts[0].collected, 220)
        assert.equal(report.summary.goalPerAccount, true)
        assert.equal(report.summary.accountsAtGoal, 0)
        assert.ok(report.accounts[0].goalProgressPercent > 0)
        assert.ok((report.accounts[0].goalProgressPercent ?? 0) < 100)
        assert.equal(report.accounts[0].pointsToGoal, 6500 - 220)
        assert.ok(report.summary.goalProgressPercent > 0)
        assert.ok(report.summary.goalProgressPercent < 100)
        assert.equal(report.levels.find(bucket => bucket.level === 'Level 2')?.count, 1)
        assert.ok(report.forecast.length > report.daily.length)
        assert.equal(report.daily.find(day => day.date === today)?.collected, 200)
    } finally {
        process.chdir(prevCwd)
        fs.rmSync(cwd, { recursive: true, force: true })
    }
})
