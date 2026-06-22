import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import fs from 'fs'
import type { Cookie } from 'patchright'
import path from 'path'

import type { Account, ConfigSaveFingerprint } from '../types/Account'
import type { Config } from '../types/Config'
import { validateAccounts, validateConfig } from './SchemaValidator'

let configCache: Config | undefined
let configFilePath: string | undefined
let accountsFilePath: string | undefined

function getSessionDir(sessionPath: string, email: string): string {
    return path.resolve(process.cwd(), sessionPath, email)
}

function getLegacySessionDir(sessionPath: string, email: string): string {
    return path.join(__dirname, '../automation/', sessionPath, email)
}

function resolveSessionFile(sessionPath: string, email: string, fileName: string): string {
    const primary = path.join(getSessionDir(sessionPath, email), fileName)
    if (fs.existsSync(primary)) return primary

    const legacy = path.join(getLegacySessionDir(sessionPath, email), fileName)
    if (fs.existsSync(legacy)) {
        console.warn(`[CONFIG] Using legacy session data from ${path.relative(process.cwd(), legacy)}`)
        return legacy
    }

    return primary
}

function resolveFirstExistingAbsolutePath(candidates: string[], label: string): string {
    const primaryCandidate = candidates[0]

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            if (primaryCandidate && candidate !== primaryCandidate) {
                console.warn(`[CONFIG] ${path.relative(process.cwd(), primaryCandidate)} not found, using ${path.relative(process.cwd(), candidate)}`)
            }

            return candidate
        }
    }

    throw new Error(`[CONFIG] Missing ${label}. Expected one of: ${candidates.join(', ')}`)
}

function resolveConfigSearchPaths(): string[] {
    const cwd = process.cwd()

    return [
        path.join(cwd, 'src', 'config.json'),
        path.join(cwd, 'config.json'),
        path.join(__dirname, '../config.json'),
        path.join(__dirname, '../config.example.json')
    ]
}

function resolveAccountsSearchPaths(): string[] {
    const cwd = process.cwd()
    const dev = process.argv.includes('-dev')

    if (dev) {
        return [
            path.join(cwd, 'src', 'accounts.dev.json'),
            path.join(cwd, 'accounts.dev.json'),
            path.join(cwd, 'src', 'accounts.json'),
            path.join(cwd, 'accounts.json'),
            path.join(__dirname, '../accounts.dev.json'),
            path.join(__dirname, '../accounts.json'),
            path.join(__dirname, '../accounts.example.json')
        ]
    }

    return [
        path.join(cwd, 'src', 'accounts.json'),
        path.join(cwd, 'accounts.json'),
        path.join(__dirname, '../accounts.json'),
        path.join(__dirname, '../accounts.example.json')
    ]
}

/** Prefer src/config.json in repo checkouts so panel edits survive npm start rebuilds. */
function resolveWritableConfigPath(): string {
    const cwd = process.cwd()
    const srcConfig = path.join(cwd, 'src', 'config.json')
    const rootConfig = path.join(cwd, 'config.json')

    if (fs.existsSync(path.join(cwd, 'src')) && fs.statSync(path.join(cwd, 'src')).isDirectory()) {
        return srcConfig
    }

    if (fs.existsSync(rootConfig)) {
        return rootConfig
    }

    const loaded = resolveConfigFilePath()
    if (path.basename(loaded).includes('example')) {
        return rootConfig
    }

    return loaded
}

function resolveWritableAccountsPath(): string {
    const cwd = process.cwd()
    const loadedBasename = path.basename(resolveAccountsFilePath())
    const srcDir = path.join(cwd, 'src')

    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
        return path.join(srcDir, loadedBasename)
    }

    const rootAccounts = path.join(cwd, loadedBasename)
    if (fs.existsSync(rootAccounts)) {
        return rootAccounts
    }

    if (loadedBasename.includes('example')) {
        return path.join(cwd, 'accounts.json')
    }

    return resolveAccountsFilePath()
}

function resolveAccountsFilePath(): string {
    if (accountsFilePath) {
        return accountsFilePath
    }

    accountsFilePath = resolveFirstExistingAbsolutePath(resolveAccountsSearchPaths(), 'accounts file')
    return accountsFilePath
}

function resolveConfigFilePath(): string {
    if (configFilePath) {
        return configFilePath
    }

    configFilePath = resolveFirstExistingAbsolutePath(resolveConfigSearchPaths(), 'config file')
    return configFilePath
}

export function getAccountsFilePath(): string {
    return resolveAccountsFilePath()
}

export function getConfigFilePath(): string {
    return resolveConfigFilePath()
}

export function loadAccounts(): Account[] {
    try {
        const accountDir = resolveAccountsFilePath()
        const accounts = fs.readFileSync(accountDir, 'utf-8')
        const accountsData = JSON.parse(accounts)

        validateAccounts(accountsData)

        return accountsData
    } catch (error) {
        throw new Error(error as string)
    }
}

export async function saveAccounts(accounts: Account[]): Promise<void> {
    const validated = validateAccounts(accounts)
    const accountDir = resolveWritableAccountsPath()
    await fs.promises.mkdir(path.dirname(accountDir), { recursive: true })
    await fs.promises.writeFile(accountDir, `${JSON.stringify(validated, null, 4)}\n`, 'utf-8')
    accountsFilePath = accountDir
}

export function loadConfig(): Config {
    try {
        if (configCache) {
            return configCache
        }

        return reloadConfig()
    } catch (error) {
        throw new Error(error as string)
    }
}

export function reloadConfig(): Config {
    try {
        const configDir = resolveConfigFilePath()
        const config = fs.readFileSync(configDir, 'utf-8')
        const configData = validateConfig(JSON.parse(config))
        configCache = configData
        return configData
    } catch (error) {
        throw new Error(error as string)
    }
}

export async function saveConfig(config: Config): Promise<Config> {
    const validated = validateConfig(config)
    const configDir = resolveWritableConfigPath()
    await fs.promises.mkdir(path.dirname(configDir), { recursive: true })
    await fs.promises.writeFile(configDir, `${JSON.stringify(validated, null, 4)}\n`, 'utf-8')
    configCache = validated
    configFilePath = configDir
    return validated
}

export interface StorageOrigin {
    origin: string
    localStorage: Array<{ name: string; value: string }>
}

export async function loadSessionData(
    sessionPath: string,
    email: string,
    saveFingerprint: ConfigSaveFingerprint,
    isMobile: boolean
) {
    try {
        const cookiesFileName = isMobile ? 'session_mobile.json' : 'session_desktop.json'
        const cookieFile = resolveSessionFile(sessionPath, email, cookiesFileName)

        let cookies: Cookie[] = []
        if (fs.existsSync(cookieFile)) {
            const cookiesData = await fs.promises.readFile(cookieFile, 'utf-8')
            try {
                cookies = JSON.parse(cookiesData)
            } catch {
                console.warn(`[SESSION] Ignoring corrupt cookie file for ${email}: ${cookieFile}`)
            }
        }

        const fingerprintFileName = isMobile ? 'session_fingerprint_mobile.json' : 'session_fingerprint_desktop.json'
        const fingerprintFile = resolveSessionFile(sessionPath, email, fingerprintFileName)

        let fingerprint!: BrowserFingerprintWithHeaders
        const shouldLoadFingerprint = isMobile ? saveFingerprint.mobile : saveFingerprint.desktop
        if (shouldLoadFingerprint && fs.existsSync(fingerprintFile)) {
            const fingerprintData = await fs.promises.readFile(fingerprintFile, 'utf-8')
            try {
                fingerprint = JSON.parse(fingerprintData)
            } catch {
                console.warn(`[SESSION] Ignoring corrupt fingerprint file for ${email}: ${fingerprintFile}`)
            }
        }

        // Load localStorage/sessionStorage data
        const storageFileName = isMobile ? 'session_storage_mobile.json' : 'session_storage_desktop.json'
        const storageFile = resolveSessionFile(sessionPath, email, storageFileName)

        let storageState: StorageOrigin[] | undefined
        if (fs.existsSync(storageFile)) {
            const storageData = await fs.promises.readFile(storageFile, 'utf-8')
            try {
                storageState = JSON.parse(storageData)
            } catch {
                console.warn(`[SESSION] Ignoring corrupt storage file for ${email}: ${storageFile}`)
            }
        }

        return {
            cookies: cookies,
            fingerprint: fingerprint,
            storageState: storageState
        }
    } catch (error) {
        throw new Error(error as string)
    }
}

export async function clearAllSessionData(sessionPath: string, email: string): Promise<void> {
    await clearSessionData(sessionPath, email, true)
    await clearSessionData(sessionPath, email, false)
}

export async function clearSessionData(
    sessionPath: string,
    email: string,
    isMobile: boolean
): Promise<void> {
    const sessionDir = getSessionDir(sessionPath, email)
    const files = isMobile
        ? ['session_mobile.json', 'session_storage_mobile.json']
        : ['session_desktop.json', 'session_storage_desktop.json']

    for (const fileName of files) {
        const filePath = path.join(sessionDir, fileName)
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath)
        }
    }
}

export async function saveSessionData(
    sessionPath: string,
    cookies: Cookie[],
    email: string,
    isMobile: boolean
): Promise<string> {
    try {
        const sessionDir = getSessionDir(sessionPath, email)
        const cookiesFileName = isMobile ? 'session_mobile.json' : 'session_desktop.json'

        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        await fs.promises.writeFile(path.join(sessionDir, cookiesFileName), JSON.stringify(cookies))

        return sessionDir
    } catch (error) {
        throw new Error(error as string)
    }
}

export async function saveFingerprintData(
    sessionPath: string,
    email: string,
    isMobile: boolean,
    fingerpint: BrowserFingerprintWithHeaders
): Promise<string> {
    try {
        const sessionDir = getSessionDir(sessionPath, email)
        const fingerprintFileName = isMobile ? 'session_fingerprint_mobile.json' : 'session_fingerprint_desktop.json'

        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        await fs.promises.writeFile(path.join(sessionDir, fingerprintFileName), JSON.stringify(fingerpint))

        return sessionDir
    } catch (error) {
        throw new Error(error as string)
    }
}

export async function saveStorageState(
    sessionPath: string,
    storageState: StorageOrigin[],
    email: string,
    isMobile: boolean
): Promise<void> {
    try {
        const sessionDir = getSessionDir(sessionPath, email)
        const storageFileName = isMobile ? 'session_storage_mobile.json' : 'session_storage_desktop.json'

        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        await fs.promises.writeFile(path.join(sessionDir, storageFileName), JSON.stringify(storageState))
    } catch (error) {
        throw new Error(error as string)
    }
}
