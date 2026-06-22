const assert = require('assert/strict')
const test = require('node:test')
const { detectBingSearchBlock } = require('../dist/automation/RewardsPageAnalyzer.js')

test('rewards dashboard is not treated as Bing sign-in block', () => {
    const html = '<html><body>Microsoft account rewards dashboard</body></html>'
    const result = detectBingSearchBlock(html, 'https://rewards.bing.com/dashboard', 'Rewards')
    assert.equal(result.blocked, false)
})

test('bing.com page with microsoft account footer text is not blocked when search box exists', () => {
    const html = '<html><body>Microsoft account<input name="q" /></body></html>'
    const result = detectBingSearchBlock(html, 'https://www.bing.com/search?q=test', 'Bing')
    assert.equal(result.blocked, false)
})

test('login.live.com is sign-in required', () => {
    const result = detectBingSearchBlock('', 'https://login.live.com/oauth20_authorize.srf', 'Sign in')
    assert.equal(result.blocked, true)
    assert.equal(result.reason, 'Bing sign-in required')
})

test('unusual activity is temp ban class', () => {
    const result = detectBingSearchBlock('unusual activity from your network', 'https://www.bing.com/search', 'Bing')
    assert.equal(result.blocked, true)
    assert.match(result.reason, /temp ban/i)
})
