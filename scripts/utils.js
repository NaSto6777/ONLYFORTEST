import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export function getDirname(importMetaUrl) {
    const __filename = fileURLToPath(importMetaUrl)
    return path.dirname(__filename)
}

export function getProjectRoot(currentDir) {
    let dir = currentDir
    while (dir !== path.parse(dir).root) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir
        }
        dir = path.dirname(dir)
    }
    throw new Error('Could not find project root (package.json not found)')
}

export function log(level, ...args) {
    console.log(`[${level}]`, ...args)
}

export function parseArgs(argv = process.argv.slice(2)) {
    const args = {}

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]

        if (!arg.startsWith('-')) {
            continue
        }

        const key = arg.startsWith('--') ? arg.slice(2).split('=')[0] : arg.slice(1).split('=')[0]

        if (arg.includes('=')) {
            const eq = arg.indexOf('=')
            args[key] = arg.slice(eq + 1)
            continue
        }

        if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
            let value = argv[i + 1]
            i++

            while (i + 1 < argv.length && !argv[i + 1].startsWith('-') && String(value).includes('?') && !String(value).includes('&')) {
                value += `&${argv[i + 1]}`
                i++
            }

            args[key] = value
        } else {
            args[key] = true
        }
    }

    return args
}

export function validateEmail(email) {
    if (!email) {
        log('ERROR', 'Missing -email argument')
        log('ERROR', 'Usage: node script.js -email you@example.com')
        process.exit(1)
    }

    if (typeof email !== 'string') {
        log('ERROR', `Invalid email type: expected string, got ${typeof email}`)
        log('ERROR', 'Usage: node script.js -email you@example.com')
        process.exit(1)
    }

    if (!email.includes('@')) {
        log('ERROR', `Invalid email format: "${email}"`)
        log('ERROR', 'Email must contain "@" symbol')
        log('ERROR', 'Example: you@example.com')
        process.exit(1)
    }

    return email
}

export function loadJsonFile(possiblePaths, required = true) {
    for (const filePath of possiblePaths) {
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath, 'utf8')
                return { data: JSON.parse(content), path: filePath }
            } catch (error) {
                log('ERROR', `Failed to parse JSON file: ${filePath}`)
                log('ERROR', `Parse error: ${error.message}`)
                if (required) process.exit(1)
                return null
            }
        }
    }

    if (required) {
        log('ERROR', 'Required file not found')
        log('ERROR', 'Searched in the following locations:')
        possiblePaths.forEach(p => log('ERROR', `  - ${p}`))
        process.exit(1)
    }

    return null
}

export function loadConfig(projectRoot, isDev = false) {
    const possiblePaths = isDev
        ? [path.join(projectRoot, 'src', 'config.json'), path.join(projectRoot, 'src', 'config.example.json')]
        : [
              path.join(projectRoot, 'dist', 'config.json'),
              path.join(projectRoot, 'src', 'config.json'),
              path.join(projectRoot, 'config.json'),
              path.join(projectRoot, 'config.example.json')
          ]

    const result = loadJsonFile(possiblePaths, true)

    const missingFields = []
    if (!result.data.baseURL) missingFields.push('baseURL')
    if (!result.data.sessionPath) missingFields.push('sessionPath')
    if (result.data.headless === undefined) missingFields.push('headless')
    if (!result.data.workers) missingFields.push('workers')

    if (missingFields.length > 0) {
        log('ERROR', 'Invalid config.json - missing required fields:')
        missingFields.forEach(field => log('ERROR', `  - ${field}`))
        log('ERROR', `Config file: ${result.path}`)
        process.exit(1)
    }

    return result
}

export function loadAccounts(projectRoot, isDev = false) {
    const possiblePaths = isDev
        ? [path.join(projectRoot, 'src', 'accounts.dev.json')]
        : [
              path.join(projectRoot, 'dist', 'accounts.json'),
              path.join(projectRoot, 'src', 'accounts.json'),
              path.join(projectRoot, 'accounts.json'),
              path.join(projectRoot, 'accounts.example.json'),
              path.join(projectRoot, 'src', 'accounts.example.json')
          ]

    return loadJsonFile(possiblePaths, true)
}

export function findAccountByEmail(accounts, email) {
    if (!email || typeof email !== 'string') return null
    return (
        accounts.find(a => a?.email && typeof a.email === 'string' && a.email.toLowerCase() === email.toLowerCase()) ||
        null
    )
}

export function resolveAccountsFilePath(projectRoot, isDev = false) {
    const candidates = isDev
        ? [
              path.join(projectRoot, 'src', 'accounts.dev.json'),
              path.join(projectRoot, 'src', 'accounts.json')
          ]
        : [
              path.join(projectRoot, 'src', 'accounts.json'),
              path.join(projectRoot, 'dist', 'accounts.json'),
              path.join(projectRoot, 'accounts.json')
          ]

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate
        }
    }

    return path.join(projectRoot, 'src', 'accounts.json')
}

export function createAccountTemplate({ email, password, recoveryEmail = '', geoLocale = 'TN', langCode = 'en' }) {
    return {
        email,
        enabled: true,
        password,
        totpSecret: '',
        recoveryEmail: recoveryEmail || '',
        geoLocale,
        langCode,
        proxy: {
            proxyAxios: false,
            url: '',
            port: 0,
            username: '',
            password: ''
        },
        saveFingerprint: {
            mobile: false,
            desktop: false
        }
    }
}

function getDailyLimitStatePath(projectRoot) {
    return path.join(projectRoot, '.msrb', 'add-account-daily.json')
}

function todayKey() {
    return new Date().toISOString().slice(0, 10)
}

export function readDailyAccountAdds(projectRoot) {
    const statePath = getDailyLimitStatePath(projectRoot)
    if (!fs.existsSync(statePath)) {
        return { date: todayKey(), count: 0 }
    }

    try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        if (state?.date !== todayKey()) {
            return { date: todayKey(), count: 0 }
        }
        return { date: state.date, count: Number(state.count) || 0 }
    } catch {
        return { date: todayKey(), count: 0 }
    }
}

export function recordAccountAddedToday(projectRoot) {
    const statePath = getDailyLimitStatePath(projectRoot)
    const dir = path.dirname(statePath)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }

    const current = readDailyAccountAdds(projectRoot)
    const next = {
        date: todayKey(),
        count: current.count + 1
    }
    fs.writeFileSync(statePath, JSON.stringify(next, null, 2))
    return next
}

export function assertDailyAccountLimit(projectRoot, maxPerDay = 3) {
    const { count } = readDailyAccountAdds(projectRoot)
    if (count >= maxPerDay) {
        log('ERROR', `Daily limit reached (${maxPerDay} accounts per day). Try again tomorrow.`)
        process.exit(1)
    }

    const remaining = maxPerDay - count
    log('INFO', `Accounts added today: ${count}/${maxPerDay} (${remaining} remaining)`)
}

export function appendAccountToFile(projectRoot, account, isDev = false) {
    const filePath = resolveAccountsFilePath(projectRoot, isDev)

    let accounts = []
    if (fs.existsSync(filePath)) {
        try {
            accounts = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            if (!Array.isArray(accounts)) {
                throw new Error('accounts file must contain a JSON array')
            }
        } catch (error) {
            throw new Error(`Cannot read ${filePath}: ${error.message}`)
        }
    }

    if (findAccountByEmail(accounts, account.email)) {
        throw new Error(`Account already exists: ${account.email}`)
    }

    if (fs.existsSync(filePath)) {
        const backupPath = `${filePath}.bak`
        fs.copyFileSync(filePath, backupPath)
    } else {
        const parent = path.dirname(filePath)
        if (!fs.existsSync(parent)) {
            fs.mkdirSync(parent, { recursive: true })
        }
    }

    accounts.push(account)
    fs.writeFileSync(filePath, `${JSON.stringify(accounts, null, 4)}\n`)
    return filePath
}

export function getRuntimeBase(projectRoot, isDev = false) {
    return path.join(projectRoot, isDev ? 'src' : 'dist')
}

export function getSessionPath(runtimeBase, sessionPath, email) {
    return path.join(runtimeBase, 'browser', sessionPath, email)
}

export function resolveAccountSessionPath(projectRoot, sessionPath, email) {
    const candidates = [
        path.join(projectRoot, sessionPath, email),
        path.join(projectRoot, 'dist', 'browser', sessionPath, email),
        path.join(projectRoot, 'src', 'browser', sessionPath, email)
    ]

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate
        }
    }

    return candidates[0]
}

export async function loadCookies(sessionBase, type = 'desktop') {
    const cookiesFile = path.join(sessionBase, `session_${type}.json`)

    if (!fs.existsSync(cookiesFile)) {
        return []
    }

    try {
        const content = await fs.promises.readFile(cookiesFile, 'utf8')
        return JSON.parse(content)
    } catch (error) {
        log('WARN', `Failed to load cookies from: ${cookiesFile}`)
        log('WARN', `Error: ${error.message}`)
        return []
    }
}

export async function loadFingerprint(sessionBase, type = 'desktop') {
    const fpFile = path.join(sessionBase, `session_fingerprint_${type}.json`)

    if (!fs.existsSync(fpFile)) {
        return null
    }

    try {
        const content = await fs.promises.readFile(fpFile, 'utf8')
        return JSON.parse(content)
    } catch (error) {
        log('WARN', `Failed to load fingerprint from: ${fpFile}`)
        log('WARN', `Error: ${error.message}`)
        return null
    }
}

export function getUserAgent(fingerprint) {
    if (!fingerprint) return null
    return fingerprint?.fingerprint?.userAgent || fingerprint?.userAgent || null
}

export function buildProxyConfig(account) {
    if (!account.proxy || !account.proxy.url || !account.proxy.port) {
        return null
    }

    const proxy = {
        server: `${account.proxy.url}:${account.proxy.port}`
    }

    if (account.proxy.username && account.proxy.password) {
        proxy.username = account.proxy.username
        proxy.password = account.proxy.password
    }

    return proxy
}

const DASHBOARD_API = 'https://rewards.bing.com/api/getuserinfo?type=1'

const LEVEL_ENGLISH_BY_CODE = {
    newLevel1: 'Bronze Member',
    newLevel2: 'Silver Member',
    newLevel3: 'Gold Member',
    Level1: 'Level 1',
    Level2: 'Level 2',
    Level3: 'Level 3'
}

export function formatLevelEnglish(levelInfo, profileLevel) {
    const code = levelInfo?.activeLevel || profileLevel || null
    if (code && LEVEL_ENGLISH_BY_CODE[code]) {
        return LEVEL_ENGLISH_BY_CODE[code]
    }

    const activeLevel = levelInfo?.levels?.find(level => level?.active)
    if (activeLevel?.key && LEVEL_ENGLISH_BY_CODE[activeLevel.key]) {
        return LEVEL_ENGLISH_BY_CODE[activeLevel.key]
    }

    const newLevelMatch = /^newLevel(\d+)$/i.exec(String(code ?? ''))
    if (newLevelMatch) {
        const names = ['', 'Bronze Member', 'Silver Member', 'Gold Member']
        return names[Number(newLevelMatch[1])] || code
    }

    return code
}

export function buildCookieHeader(cookies, allowedDomains = []) {
    return [
        ...new Map(
            cookies
                .filter(cookie => {
                    if (!allowedDomains.length) return true
                    return (
                        typeof cookie.domain === 'string' &&
                        allowedDomains.some(domain => cookie.domain.toLowerCase().endsWith(domain.toLowerCase()))
                    )
                })
                .map(cookie => [cookie.name, cookie])
        ).values()
    ]
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ')
}

export async function fetchAccountRewardsStats(sessionBase) {
    let cookies = await loadCookies(sessionBase, 'mobile')
    if (!cookies.length) {
        cookies = await loadCookies(sessionBase, 'desktop')
    }
    if (!cookies.length) {
        return null
    }

    const cookieHeader = buildCookieHeader(cookies, ['bing.com', 'live.com', 'microsoftonline.com'])
    if (!cookieHeader) {
        return null
    }

    const response = await fetch(DASHBOARD_API, {
        headers: {
            Cookie: cookieHeader,
            Referer: 'https://rewards.bing.com/',
            Origin: 'https://rewards.bing.com',
            Accept: 'application/json'
        },
        signal: AbortSignal.timeout(12_000)
    })

    if (!response.ok) {
        return null
    }

    const payload = await response.json()
    const dashboard = payload?.dashboard
    if (!dashboard?.userStatus) {
        return null
    }

    const points = Number(dashboard.userStatus.availablePoints ?? 0)
    const streak = Number.parseInt(dashboard.streakProtectionPromo?.streakCount ?? '0', 10) || 0
    const todayPoints =
        dashboard.userStatus.counters?.dailyPoint?.reduce(
            (sum, counter) => sum + Number(counter.pointProgress ?? 0),
            0
        ) ?? 0
    const level = formatLevelEnglish(
        dashboard.userStatus.levelInfo,
        dashboard.userProfile?.attributes?.level
    )

    return { points, streak, todayPoints, level }
}

export function setupCleanupHandlers(cleanupFn) {
    const cleanup = async () => {
        try {
            await cleanupFn()
        } catch (error) {
            log('ERROR', 'Cleanup failed:', error.message)
        }
        process.exit(0)
    }

    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
}

export function validateDeletionPath(targetPath, projectRoot) {
    const normalizedTarget = path.normalize(targetPath)
    const normalizedRoot = path.normalize(projectRoot)

    if (!normalizedTarget.startsWith(normalizedRoot)) {
        return {
            valid: false,
            error: 'Path is outside project root'
        }
    }

    if (normalizedTarget === normalizedRoot) {
        return {
            valid: false,
            error: 'Cannot delete project root'
        }
    }

    const pathSegments = normalizedTarget.split(path.sep)
    if (pathSegments.length < 3) {
        return {
            valid: false,
            error: 'Path is too shallow (safety check failed)'
        }
    }

    return { valid: true, error: null }
}

export function safeRemoveDirectory(dirPath, projectRoot) {
    const validation = validateDeletionPath(dirPath, projectRoot)

    if (!validation.valid) {
        log('ERROR', 'Directory deletion failed - safety check:')
        log('ERROR', `  Reason: ${validation.error}`)
        log('ERROR', `  Target: ${dirPath}`)
        log('ERROR', `  Project root: ${projectRoot}`)
        return false
    }

    if (!fs.existsSync(dirPath)) {
        log('INFO', `Directory does not exist: ${dirPath}`)
        return true
    }

    try {
        fs.rmSync(dirPath, { recursive: true, force: true })
        log('SUCCESS', `Directory removed: ${dirPath}`)
        return true
    } catch (error) {
        log('ERROR', `Failed to remove directory: ${dirPath}`)
        log('ERROR', `Error: ${error.message}`)
        return false
    }
}
