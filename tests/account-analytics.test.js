const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const { compareLevels, rankFromLevel } = require('../dist/helpers/AccountLevelUtils')
const { saveAccountDashboardSnapshot, getAccountDashboardSnapshot } = require('../dist/helpers/AccountDashboardSnapshotLedger')
const { getAccountRunStatsToday, recordAccountRun } = require('../dist/helpers/AccountRunLedger')

test('rankFromLevel parses numeric and named levels', () => {
    assert.equal(rankFromLevel('Level 1'), 1)
    assert.equal(rankFromLevel('Level 2'), 2)
    assert.equal(rankFromLevel('Gold'), 3)
    assert.equal(rankFromLevel(null), null)
})

test('compareLevels detects upgrades and downgrades', () => {
    assert.equal(
        compareLevels({ level: 'Level 1', levelKey: '1' }, { level: 'Level 2', levelKey: '2' }),
        'up'
    )
    assert.equal(
        compareLevels({ level: 'Level 2', levelKey: '2' }, { level: 'Level 1', levelKey: '1' }),
        'down'
    )
    assert.equal(
        compareLevels({ level: 'Level 2', levelKey: '2' }, { level: 'Level 2', levelKey: '2' }),
        'same'
    )
})

test('dashboard snapshot stores level changes and run ledger keeps duration analytics', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-analytics-'))

    saveAccountDashboardSnapshot(
        'user@example.com',
        {
            userName: 'User',
            level: 'Level 1',
            levelKey: '1',
            availablePoints: 1000,
            readyToClaimPoints: 0,
            claimEntries: [],
            hasClaimEntryExpiringSoon: false,
            todayPoints: 10,
            streakDays: 3,
            dailySetCompleted: 1,
            dailySetTotal: 3
        },
        cwd
    )

    saveAccountDashboardSnapshot(
        'user@example.com',
        {
            userName: 'User',
            level: 'Level 2',
            levelKey: '2',
            availablePoints: 1500,
            readyToClaimPoints: 0,
            claimEntries: [],
            hasClaimEntryExpiringSoon: false,
            todayPoints: 40,
            streakDays: 3,
            dailySetCompleted: 3,
            dailySetTotal: 3
        },
        cwd
    )

    const snapshot = getAccountDashboardSnapshot('user@example.com', cwd)
    assert.equal(snapshot?.availablePoints, 1500)
    assert.equal(snapshot?.lastLevelChange?.direction, 'up')
    assert.equal(snapshot?.lastLevelChange?.toLevel, 'Level 2')

    recordAccountRun(
        {
            email: 'user@example.com',
            success: true,
            completedAt: new Date().toISOString(),
            collectedPoints: 32,
            durationSeconds: 252,
            level: 'Level 2'
        },
        cwd
    )

    const stats = getAccountRunStatsToday('user@example.com', cwd)
    assert.equal(stats.runs, 1)
    assert.equal(stats.collectedPoints, 32)
    assert.equal(stats.lastRun?.durationSeconds, 252)
})
