const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const { StaleRewardsSessionError } = require('../dist/errors/RewardsSessionErrors')
const { maybeRecordStaleSession } = require('../dist/helpers/AccountSessionIssues')
const {
    getAccountSearchIssue,
    isAccountStaleSessionToday,
    clearAccountStaleSession
} = require('../dist/helpers/AccountTempBanLedger')

test('maybeRecordStaleSession records recoverable dashboard failures', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-stale-session-'))

    maybeRecordStaleSession('broken@example.com', new StaleRewardsSessionError('broken@example.com'), cwd)
    assert.equal(isAccountStaleSessionToday('broken@example.com', cwd), true)

    maybeRecordStaleSession('broken@example.com', new Error('Failed to get dashboard data'), cwd)
    assert.equal(getAccountSearchIssue('broken@example.com', cwd)?.reason, 'Failed to get dashboard data')

    clearAccountStaleSession('broken@example.com', cwd)
    assert.equal(isAccountStaleSessionToday('broken@example.com', cwd), false)
})

test('control panel exposes stale session accounts in status', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'control-panel', 'index.html'), 'utf8')
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'control-panel', 'app.js'), 'utf8')
    const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'ControlPanelService.ts'), 'utf8')

    assert.match(html, /dash-session-alert/)
    assert.match(app, /stale_session/)
    assert.match(app, /paintStaleSessionAlert/)
    assert.match(service, /staleSessionAccounts/)
})
