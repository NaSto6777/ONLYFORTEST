import type { Account } from '../types/Account'
import type { Config, ConfigWorkers } from '../types/Config'
import type { DashboardLog } from '../types/Dashboard'
import type { MicrosoftRewardsBot } from '../index'
import { getAccountsFinishedToday, getRunsToday } from '../helpers/AccountRunLedger'
import { getAccountDashboardSnapshots, type AccountDashboardSnapshot } from '../helpers/AccountDashboardSnapshotLedger'
import {
    clearAllSessionData,
    loadAccounts,
    reloadConfig,
    saveAccounts,
    saveConfig
} from '../helpers/ConfigLoader'
import { clearAccountSearchIssues, getAccountSearchIssue, getAccountsWithStaleSessionToday } from '../helpers/AccountTempBanLedger'
import { formatScheduledRun, getNextScheduledRun, isSchedulerEnabled } from './Scheduler'
import type { ClusterRunProgress, ClusterWorkerStatus } from '../types/ClusterWorker'

export interface SanitizedAccount {
    email: string
    enabled: boolean
    geoLocale: string
    langCode: string
    recoveryEmail: string
    hasPassword: boolean
    hasTotp: boolean
    finishedToday: boolean
    sessionOpen: boolean
    searchIssue: 'none' | 'needs_sign_in' | 'temp_banned' | 'stale_session'
    searchIssueReason: string | null
    dashboardStats: AccountDashboardSnapshot | null
    proxy: {
        proxyAxios: boolean
        url: string
        port: number
        username: string
        hasPassword: boolean
    }
    saveFingerprint: Account['saveFingerprint']
}

export interface ControlPanelStatus {
    runState: MicrosoftRewardsBot['dashboardRunState']
    version: string
    uptimeMs: number
    startedAt: string
    clusters: number
    headless: boolean
    enabledAccounts: number
    pendingAccounts: number
    finishedToday: number
    pointsToday: number
    schedulerEnabled: boolean
    nextScheduledRun: string | null
    controlPanelRunOnStartup: boolean
    stopRequested: boolean
    runRequested: boolean
    runAccount: string | null
    dashboardInfoEnabled: boolean
    clusterWorkers: ClusterWorkerStatus[]
    runProgress: ClusterRunProgress | null
    staleSessionAccounts: string[]
}

export interface ControlPanelConfigSnapshot {
    headless: boolean
    clusters: number
    searchOnBingLocalQueries: boolean
    workers: ConfigWorkers
    scheduler?: Config['scheduler']
    backgroundAgent?: Config['backgroundAgent']
    consoleLogFilter: Config['consoleLogFilter']
    searchSettings: Pick<Config['searchSettings'], 'searchDelay' | 'readDelay' | 'scrollRandomResults' | 'clickRandomResults'>
    controlPanel?: Config['controlPanel']
}

const ALLOWED_CONFIG_KEYS = new Set([
    'headless',
    'clusters',
    'searchOnBingLocalQueries',
    'workers',
    'scheduler',
    'backgroundAgent',
    'consoleLogFilter',
    'searchSettings',
    'controlPanel'
])

export class ControlPanelService {
    private readonly startedAt = Date.now()

    constructor(private readonly bot: MicrosoftRewardsBot) {}

    getStatus(): ControlPanelStatus {
        const finishedTodaySet = getAccountsFinishedToday()
        const enabledAccounts = loadAccounts().filter(account => account.enabled !== false)
        const pendingAccounts = enabledAccounts.filter(
            account => !finishedTodaySet.has(account.email.toLowerCase())
        ).length
        const runsToday = getRunsToday()
        const scheduler = this.bot.config.scheduler
        const staleSessionAccounts = getAccountsWithStaleSessionToday().map(entry => entry.email)

        return {
            runState: this.bot.dashboardRunState,
            version: this.bot.appVersion,
            uptimeMs: Date.now() - this.startedAt,
            startedAt: new Date(this.startedAt).toISOString(),
            clusters: this.bot.config.clusters,
            headless: this.bot.config.headless,
            enabledAccounts: enabledAccounts.length,
            pendingAccounts,
            finishedToday: finishedTodaySet.size,
            pointsToday: runsToday.reduce((sum, run) => sum + (run.collectedPoints ?? 0), 0),
            schedulerEnabled: isSchedulerEnabled(scheduler),
            nextScheduledRun:
                scheduler && isSchedulerEnabled(scheduler)
                    ? formatScheduledRun(getNextScheduledRun(scheduler), scheduler.timezone)
                    : null,
            controlPanelRunOnStartup: this.bot.config.controlPanel?.runOnStartup !== false,
            stopRequested: this.bot.dashboardStopRequested,
            runRequested: this.bot.localRunRequested,
            runAccount: this.bot.localRunAccountSelector,
            dashboardInfoEnabled: this.bot.config.workers.doDashboardInfo === true,
            clusterWorkers: [...this.bot.clusterWorkers.values()].sort((a, b) => a.workerId - b.workerId),
            runProgress: this.bot.clusterRunProgress,
            staleSessionAccounts
        }
    }

    getAccounts(): SanitizedAccount[] {
        const finishedToday = getAccountsFinishedToday()
        const dashboardSnapshots = this.bot.config.workers.doDashboardInfo
            ? getAccountDashboardSnapshots()
            : {}

        return loadAccounts().map(account =>
            this.sanitizeAccount(
                account,
                finishedToday.has(account.email.toLowerCase()),
                dashboardSnapshots[account.email.toLowerCase()] ?? null
            )
        )
    }

    getDashboardSnapshots(): Record<string, AccountDashboardSnapshot> {
        if (!this.bot.config.workers.doDashboardInfo) {
            return {}
        }
        return getAccountDashboardSnapshots()
    }

    private searchIssueForAccount(email: string): {
        searchIssue: SanitizedAccount['searchIssue']
        searchIssueReason: string | null
    } {
        const issue = getAccountSearchIssue(email)
        if (!issue) {
            return { searchIssue: 'none', searchIssueReason: null }
        }
        if (issue.kind === 'needs_sign_in') {
            return { searchIssue: 'needs_sign_in', searchIssueReason: issue.reason }
        }
        if (issue.kind === 'stale_session') {
            return { searchIssue: 'stale_session', searchIssueReason: issue.reason }
        }
        return { searchIssue: 'temp_banned', searchIssueReason: issue.reason }
    }

    async patchAccount(email: string, patch: Record<string, unknown>): Promise<SanitizedAccount> {
        const accounts = loadAccounts()
        const index = accounts.findIndex(account => account.email.toLowerCase() === email.toLowerCase())
        if (index === -1) {
            throw new Error(`Account not found: ${email}`)
        }

        const current = accounts[index]!
        const updated: Account = {
            ...current,
            enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
            geoLocale: typeof patch.geoLocale === 'string' ? patch.geoLocale : current.geoLocale,
            langCode: typeof patch.langCode === 'string' ? patch.langCode : current.langCode,
            recoveryEmail: typeof patch.recoveryEmail === 'string' ? patch.recoveryEmail : current.recoveryEmail,
            proxy: {
                ...current.proxy,
                proxyAxios:
                    patch.proxy && typeof (patch.proxy as Account['proxy']).proxyAxios === 'boolean'
                        ? (patch.proxy as Account['proxy']).proxyAxios
                        : current.proxy.proxyAxios,
                url:
                    patch.proxy && typeof (patch.proxy as Account['proxy']).url === 'string'
                        ? (patch.proxy as Account['proxy']).url
                        : current.proxy.url,
                port:
                    patch.proxy && typeof (patch.proxy as Account['proxy']).port === 'number'
                        ? (patch.proxy as Account['proxy']).port
                        : current.proxy.port,
                username:
                    patch.proxy && typeof (patch.proxy as Account['proxy']).username === 'string'
                        ? (patch.proxy as Account['proxy']).username
                        : current.proxy.username,
                password: current.proxy.password
            },
            saveFingerprint:
                patch.saveFingerprint && typeof patch.saveFingerprint === 'object'
                    ? {
                          mobile:
                              typeof (patch.saveFingerprint as Account['saveFingerprint']).mobile === 'boolean'
                                  ? (patch.saveFingerprint as Account['saveFingerprint']).mobile
                                  : current.saveFingerprint.mobile,
                          desktop:
                              typeof (patch.saveFingerprint as Account['saveFingerprint']).desktop === 'boolean'
                                  ? (patch.saveFingerprint as Account['saveFingerprint']).desktop
                                  : current.saveFingerprint.desktop
                      }
                    : current.saveFingerprint
        }

        accounts[index] = updated
        await saveAccounts(accounts)
        await this.bot.reloadAccounts()

        const finishedToday = getAccountsFinishedToday()
        const dashboardSnapshots = this.bot.config.workers.doDashboardInfo
            ? getAccountDashboardSnapshots()
            : {}
        return this.sanitizeAccount(
            updated,
            finishedToday.has(updated.email.toLowerCase()),
            dashboardSnapshots[updated.email.toLowerCase()] ?? null
        )
    }

    async clearAccountSession(email: string): Promise<void> {
        const accounts = loadAccounts()
        if (!accounts.some(account => account.email.toLowerCase() === email.toLowerCase())) {
            throw new Error(`Account not found: ${email}`)
        }

        if (this.bot.isDesktopSessionOpen(email)) {
            await this.bot.closeDesktopSession(email)
        }

        await clearAllSessionData(this.bot.config.sessionPath, email)
        clearAccountSearchIssues(email)
    }

    async openDesktopSession(email: string, target: 'rewards' | 'bing' = 'rewards'): Promise<void> {
        await this.bot.openDesktopSession(email, target)
    }

    async closeDesktopSession(email: string): Promise<void> {
        await this.bot.closeDesktopSession(email)
    }

    getConfigSnapshot(): ControlPanelConfigSnapshot {
        const config = this.bot.config
        return {
            headless: config.headless,
            clusters: config.clusters,
            searchOnBingLocalQueries: config.searchOnBingLocalQueries,
            workers: { ...config.workers },
            scheduler: config.scheduler ? { ...config.scheduler } : undefined,
            backgroundAgent: config.backgroundAgent ? { ...config.backgroundAgent } : undefined,
            consoleLogFilter: { ...config.consoleLogFilter },
            searchSettings: {
                scrollRandomResults: config.searchSettings.scrollRandomResults,
                clickRandomResults: config.searchSettings.clickRandomResults,
                searchDelay: { ...config.searchSettings.searchDelay },
                readDelay: { ...config.searchSettings.readDelay }
            },
            controlPanel: config.controlPanel ? { ...config.controlPanel } : undefined
        }
    }

    async patchConfig(patch: Record<string, unknown>): Promise<ControlPanelConfigSnapshot> {
        this.assertAllowlistedPatch(patch)

        const current = reloadConfig()
        const merged = this.mergeAllowlistedConfig(current, patch)
        const saved = await saveConfig(merged)
        this.bot.applyConfig(saved)

        return this.getConfigSnapshot()
    }

    requestRun(options?: string | { account?: string; accounts?: string[]; ignoreTempBan?: boolean }): void {
        if (this.bot.dashboardRunState === 'running' || this.bot.dashboardRunState === 'checking') {
            throw new Error('Bot is already running')
        }

        this.bot.localRunAccountSelector = null
        this.bot.localRunAccountList = null
        this.bot.localRunIgnoreTempBan = false
        this.bot.localRunBypassFinishedFilter = false

        if (typeof options === 'string') {
            if (options.trim()) {
                this.bot.localRunAccountSelector = options.trim()
                this.bot.localRunBypassFinishedFilter = true
            }
        } else if (options) {
            if (options.ignoreTempBan) {
                this.bot.localRunIgnoreTempBan = true
            }
            if (options.accounts?.length) {
                const emails = options.accounts.map(email => email.trim()).filter(Boolean)
                if (!emails.length) {
                    throw new Error('No accounts selected')
                }
                this.bot.localRunAccountList = emails
                this.bot.localRunBypassFinishedFilter = true
            } else if (options.account?.trim()) {
                this.bot.localRunAccountSelector = options.account.trim()
                this.bot.localRunBypassFinishedFilter = true
            } else if (options.ignoreTempBan) {
                this.bot.localRunBypassFinishedFilter = true
            }
        } else {
            this.bot.localRunBypassFinishedFilter = true
        }

        this.bot.localRunRequested = true
    }

    requestStop(): void {
        this.bot.dashboardStopRequested = true
    }

    getLogs(): DashboardLog[] {
        return [...this.bot.dashboardEvents]
    }

    getRunsToday() {
        return getRunsToday()
    }

    private sanitizeAccount(
        account: Account,
        finishedToday: boolean,
        dashboardStats: AccountDashboardSnapshot | null
    ): SanitizedAccount {
        return {
            email: account.email,
            enabled: account.enabled !== false,
            geoLocale: account.geoLocale,
            langCode: account.langCode,
            recoveryEmail: account.recoveryEmail,
            hasPassword: Boolean(account.password),
            hasTotp: Boolean(account.totpSecret),
            finishedToday,
            sessionOpen: this.bot.isDesktopSessionOpen(account.email),
            ...this.searchIssueForAccount(account.email),
            dashboardStats,
            proxy: {
                proxyAxios: account.proxy.proxyAxios,
                url: account.proxy.url,
                port: account.proxy.port,
                username: account.proxy.username,
                hasPassword: Boolean(account.proxy.password)
            },
            saveFingerprint: { ...account.saveFingerprint }
        }
    }

    private assertAllowlistedPatch(patch: Record<string, unknown>, prefix = ''): void {
        for (const key of Object.keys(patch)) {
            const fullKey = prefix ? `${prefix}.${key}` : key
            const rootKey = fullKey.split('.')[0] ?? fullKey
            if (!ALLOWED_CONFIG_KEYS.has(rootKey)) {
                throw new Error(`Config key not allowed: ${fullKey}`)
            }

            const value = patch[key]
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                this.assertAllowlistedPatch(value as Record<string, unknown>, fullKey)
            }
        }
    }

    private mergeAllowlistedConfig(current: Config, patch: Record<string, unknown>): Config {
        const next: Config = {
            ...current,
            headless: patch.headless !== undefined ? Boolean(patch.headless) : current.headless,
            clusters: typeof patch.clusters === 'number' ? patch.clusters : current.clusters,
            searchOnBingLocalQueries:
                patch.searchOnBingLocalQueries !== undefined
                    ? Boolean(patch.searchOnBingLocalQueries)
                    : current.searchOnBingLocalQueries,
            workers: patch.workers ? { ...current.workers, ...(patch.workers as ConfigWorkers) } : current.workers,
            scheduler: patch.scheduler
                ? { ...(current.scheduler ?? {}), ...(patch.scheduler as NonNullable<Config['scheduler']>) }
                : current.scheduler,
            backgroundAgent: patch.backgroundAgent
                ? {
                      ...(current.backgroundAgent ?? {
                          enabled: true,
                          allowDashboardAutostart: true,
                          openConsole: true
                      }),
                      ...(patch.backgroundAgent as NonNullable<Config['backgroundAgent']>)
                  }
                : current.backgroundAgent,
            consoleLogFilter: patch.consoleLogFilter
                ? { ...current.consoleLogFilter, ...(patch.consoleLogFilter as Config['consoleLogFilter']) }
                : current.consoleLogFilter,
            searchSettings: patch.searchSettings
                ? {
                      ...current.searchSettings,
                      ...(patch.searchSettings as Partial<Config['searchSettings']>),
                      searchDelay: {
                          ...current.searchSettings.searchDelay,
                          ...((patch.searchSettings as Config['searchSettings']).searchDelay ?? {})
                      },
                      readDelay: {
                          ...current.searchSettings.readDelay,
                          ...((patch.searchSettings as Config['searchSettings']).readDelay ?? {})
                      }
                  }
                : current.searchSettings,
            controlPanel: patch.controlPanel
                ? {
                      ...(current.controlPanel ?? { enabled: true, port: 4780, runOnStartup: false }),
                      ...(patch.controlPanel as NonNullable<Config['controlPanel']>)
                  }
                : current.controlPanel
        }

        return next
    }
}
