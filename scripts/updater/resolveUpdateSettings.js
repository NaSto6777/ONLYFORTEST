const fs = require('fs')
const path = require('path')

const DEFAULT_REPO = 'QuestPilot/Microsoft-Rewards-Bot'
const DEFAULT_BRANCH = 'main'

function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) {
        return null
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
        return null
    }
}

function parseGithubRepo(value) {
    if (!value || typeof value !== 'string') {
        return null
    }

    const trimmed = value.trim()
    if (!trimmed) {
        return null
    }

    if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
        return trimmed
    }

    const match = trimmed.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:[/?#]|$)/i)
    if (match) {
        return `${match[1]}/${match[2]}`
    }

    return null
}

function readUserConfig(root) {
    for (const relativePath of ['src/config.json', 'dist/config.json']) {
        const config = readJsonIfExists(path.join(root, relativePath))
        if (config) {
            return config
        }
    }

    return {}
}

function resolveUpdateSettings(options = {}) {
    const root = options.root ?? path.resolve(__dirname, '..', '..')
    const env = options.env ?? process.env
    const userConfig = readUserConfig(root)
    const packageJson = readJsonIfExists(path.join(root, 'package.json')) ?? {}
    const updates = userConfig.updates ?? {}

    const enabledFromEnv =
        env.MSRB_AUTO_UPDATE === '1' || env.MSRB_AUTO_UPDATE === 'true'
            ? true
            : env.MSRB_AUTO_UPDATE === '0' || env.MSRB_AUTO_UPDATE === 'false'
              ? false
              : null

    const enabled = enabledFromEnv ?? (typeof updates.enabled === 'boolean' ? updates.enabled : true)

    const repo =
        parseGithubRepo(env.MSRB_UPDATE_REPO) ??
        parseGithubRepo(updates.repo) ??
        parseGithubRepo(packageJson.repository?.url) ??
        DEFAULT_REPO

    const branch = (env.MSRB_UPDATE_BRANCH ?? updates.branch ?? DEFAULT_BRANCH).trim() || DEFAULT_BRANCH

    return {
        enabled,
        repo,
        branch
    }
}

module.exports = {
    parseGithubRepo,
    resolveUpdateSettings
}
