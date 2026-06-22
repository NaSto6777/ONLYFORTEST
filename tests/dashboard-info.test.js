const assert = require('assert/strict')
const test = require('node:test')

test('dashboard info maps daily set completion from dashboard data', () => {
    const { DashboardInfoCollector } = require('../dist/core/tasks/browser/DashboardInfo.js')

    const data = {
        dailySetPromotions: {
            '06/20/2026': [
                { pointProgressMax: 10, complete: true },
                { pointProgressMax: 10, complete: true },
                { pointProgressMax: 10, complete: false }
            ]
        },
        userStatus: { availablePoints: 1000, levelInfo: { activeLevelName: 'Level 2' } },
        userProfile: { attributes: {} },
        streakProtectionPromo: { streakCount: '14' }
    }

    const bot = {
        userData: { userName: 'test' },
        utils: {
            getFormattedDate: () => '06/20/2026'
        },
        browser: {
            func: {
                getDashboardData: async () => data
            }
        },
        logger: { warn() {}, info() {}, error() {}, debug() {} }
    }

    const collector = new DashboardInfoCollector(bot)
    const info = collector.refreshDashboardSnapshot(null)

    return info.then(result => {
        assert.equal(result.dailySetCompleted, 2)
        assert.equal(result.dailySetTotal, 3)
        assert.equal(result.streakDays, 14)
        assert.equal(result.level, 'Level 2')
    })
})

test('account dashboard snapshot ledger round-trips', () => {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')
    const {
        saveAccountDashboardSnapshot,
        getAccountDashboardSnapshot
    } = require('../dist/helpers/AccountDashboardSnapshotLedger.js')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-snap-'))
    try {
        saveAccountDashboardSnapshot(
            'user@example.com',
            {
                userName: 'user',
                level: 'Gold',
                availablePoints: 5000,
                readyToClaimPoints: 0,
                claimEntries: [],
                hasClaimEntryExpiringSoon: false,
                todayPoints: 120,
                streakDays: 7,
                dailySetCompleted: 2,
                dailySetTotal: 3
            },
            tmpDir
        )

        const snapshot = getAccountDashboardSnapshot('user@example.com', tmpDir)
        assert.equal(snapshot.level, 'Gold')
        assert.equal(snapshot.dailySetCompleted, 2)
        assert.equal(snapshot.dailySetTotal, 3)
        assert.equal(snapshot.streakDays, 7)
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    }
})
