const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..')

test('public example config starts with Core-only workers disabled', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'src/config.example.json'), 'utf8'))

    assert.equal(config.workers.doAppPromotions, false)
    assert.equal(config.workers.doDailyCheckIn, false)
    assert.equal(config.workers.doReadToEarn, false)
    assert.equal(config.workers.doDailyStreak, false)
    assert.equal(config.workers.doRedeemGoal, false)
    assert.equal(config.workers.doDashboardInfo, false)
    assert.equal(config.workers.doClaimPoints, false)
})

test('open-source premium fallbacks show concise Core hints', () => {
    const runner = fs.readFileSync(path.join(root, 'src/core/ActivityRunner.ts'), 'utf8')
    const taskBase = fs.readFileSync(path.join(root, 'src/core/TaskBase.ts'), 'utf8')

    assert.match(runner, /CORE-OPTIONAL/)
    assert.match(runner, /Learn more: https:\/\/github\.com\/QuestPilot\/Microsoft-Rewards-Bot\/blob\/HEAD\/docs\/core-plugin\.md/)
    assert.match(runner, /premiumHintsShown/)
    assert.match(taskBase, /Core unlocks full Daily Set coverage/)
})

test('fresh installs ship plugins.example.jsonc with Core disabled', () => {
    const examplePath = path.join(root, 'plugins', 'plugins.example.jsonc')
    assert.ok(fs.existsSync(examplePath), 'plugins/plugins.example.jsonc should be committed')

    const raw = fs.readFileSync(examplePath, 'utf8')
    const json = raw
        .split('\n')
        .map(line => (line.includes('//') ? line.slice(0, line.indexOf('//')) : line))
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,(\s*[}\]])/g, '$1')

    const config = JSON.parse(json)
    assert.equal(config.core?.enabled, false)
})

test('PluginManager skips Core when plugins.jsonc is missing', () => {
    const source = fs.readFileSync(path.join(root, 'src/core/PluginManager.ts'), 'utf8')
    assert.match(source, /Core plugin skipped by default/)
})
