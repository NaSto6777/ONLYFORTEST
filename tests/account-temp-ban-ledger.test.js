const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const {
    clearAccountTempBan,
    getAccountSearchIssue,
    isAccountTempBannedToday,
    isAccountNeedsSignInToday,
    recordAccountNeedsSignIn,
    recordAccountSearchIssue
} = require('../dist/helpers/AccountTempBanLedger')

test('clearAccountTempBan removes temp ban but keeps needs_sign_in', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-tempban-'))

    recordAccountNeedsSignIn({
        email: 'user@example.com',
        reason: 'sign in',
        recordedAt: new Date().toISOString()
    }, cwd)

    recordAccountSearchIssue({
        email: 'user@example.com',
        kind: 'temp_ban',
        reason: 'blocked',
        recordedAt: new Date().toISOString()
    }, cwd)

    assert.equal(isAccountTempBannedToday('user@example.com', cwd), true)

    clearAccountTempBan('user@example.com', cwd)

    assert.equal(isAccountTempBannedToday('user@example.com', cwd), false)
    assert.equal(isAccountNeedsSignInToday('user@example.com', cwd), true)
    assert.equal(getAccountSearchIssue('user@example.com', cwd)?.kind, 'needs_sign_in')
})
