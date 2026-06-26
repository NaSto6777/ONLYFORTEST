import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import AutomationUtils from './automation/AutomationUtils'
import BrowserManager from './automation/BrowserManager'
import PageController from './automation/PageController'

import type { ClusterRunProgress, ClusterWorkerPhase, ClusterWorkerStatus } from './types/ClusterWorker'
import type { PasswordlessAuthPrompt, PasswordlessAuthPromptInput } from './types/PasswordlessAuthPrompt'
import { loadAccounts, loadConfig } from './helpers/ConfigLoader'
import Helpers from './helpers/Helpers'
import { getPackageMetadata } from './helpers/PackageMetadata'
import { checkNodeVersion } from './helpers/SchemaValidator'
import { IpcLog, LogService } from './notifications/LogService'

import { AuthManager } from './automation/auth/AuthManager'
import { executionContext, getCurrentContext } from './context/ExecutionContext'
import ActivityRunner from './core/ActivityRunner'
import { SearchOrchestrator } from './core/SearchOrchestrator'
import { TaskBase } from './core/TaskBase'

import type { DashboardInfo } from './core/InternalPluginAPI'
import { PluginManager } from './core/PluginManager'
import { checkSafetyAdvisory } from './core/SafetyAdvisory'
import { formatScheduledRun, getNextScheduledRun, isSchedulerEnabled, waitUntil } from './core/Scheduler'
import {
    AgentRuntime,
    attachToAgent,
    confirmReplaceExistingAgent,
    isAgentActive,
    stopExistingAgent
} from './core/AgentRuntime'
import { LocalControlServer } from './core/LocalControlServer'
import { findAccountBySelector, findAccountsBySelector, getCliAccountSelector } from './helpers/CliArgs'
import { getAccountsFinishedToday, recordAccountRun } from './helpers/AccountRunLedger'
import { clearAccountStaleSession } from './helpers/AccountTempBanLedger'
import { maybeRecordStaleSession } from './helpers/AccountSessionIssues'
import { getAccountDashboardSnapshot, saveAccountDashboardSnapshot } from './helpers/AccountDashboardSnapshotLedger'
import {
    renderRunEndBanner,
    renderRunPlan,
    renderRunSummaryTable,
    renderStartupBanner
} from './helpers/TerminalBanner'
import HttpClient from './helpers/HttpClient'
import { flushDiscordQueue, sendDiscord } from './notifications/DiscordWebhook'
import { flushNtfyQueue, sendNtfy } from './notifications/NtfyWebhook'
import type { Account } from './types/Account'
import type { Config } from './types/Config'
import type { AppDashboardData } from './types/AppDashboardData'
import type { DashboardLog } from './types/Dashboard'
import type { DashboardData } from './types/DashboardData'

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
}

type ClusterIpcFromWorker = {
    __ready?: boolean
    __pullWork?: boolean
    __workerStatus?: ClusterWorkerStatus
    __accountDone?: AccountStats
    __ipcLog?: IpcLog
}

type ClusterIpcToWorker = {
    __init?: {
        workerId: number
        runStartTime: number
        ignoreTempBan?: boolean
        initialAccount?: Account | null
    }
    __work?: Account | null
}

// Re-exported so callers that already import from this module keep working
export { executionContext, getCurrentContext }

const pkg = getPackageMetadata()

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([flushDiscordQueue(timeoutMs), flushNtfyQueue(timeoutMs)])
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
    dashboardInfo: DashboardInfo | null
}

export class MicrosoftRewardsBot {
    public readonly appVersion = pkg.version
    public logger: LogService
    public config
    public utils: Helpers
    public activities: ActivityRunner = new ActivityRunner(this)
    public pluginManager: PluginManager = new PluginManager(this)
    public browser: { func: PageController; utils: AutomationUtils }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page

    public userData: UserData

    public accessToken = ''
    public requestToken = ''
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
    public fingerprint!: BrowserFingerprintWithHeaders
    public dashboardEvents: DashboardLog[] = []
    public dashboardRunState: 'idle' | 'checking' | 'running' | 'waiting' | 'finished' | 'blocked' | 'error' = 'idle'
    public dashboardStopRequested = false
    public localRunRequested = false
    public localRunAccountSelector: string | null = null
    /** Explicit account emails chosen in the control panel run modal (skips finished-today filter). */
    public localRunAccountList: string[] | null = null
    /** When true, Bing searches run even if the account was marked search-limited today. */
    public localRunIgnoreTempBan = false
    /** When true, skip the finished-today filter for this control-panel run. */
    public localRunBypassFinishedFilter = false
    public clusterWorkers = new Map<number, ClusterWorkerStatus>()
    public clusterRunProgress: ClusterRunProgress | null = null
    public localControlServer: LocalControlServer | null = null
    public passwordlessPrompt: PasswordlessAuthPrompt | null = null
    public promotionRunActive = false
    public agentRuntime: AgentRuntime = new AgentRuntime()

    private desktopViewerSessions = new Map<string, BrowserContext>()
    private mobileViewerSessions = new Map<string, BrowserContext>()

    private clusterWorkerId = 1
    private clusterWorkerLocalCompleted = 0

    private pointsCanCollect = 0

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: BrowserManager = new BrowserManager(this)
    private accounts: Account[]
    private workers: TaskBase
    private login = new AuthManager(this)
    private searchManager: SearchOrchestrator

    public axios!: HttpClient

    constructor() {
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0,
            dashboardInfo: null
        }
        this.logger = new LogService(this)
        this.accounts = []
        this.cookies = { mobile: [], desktop: [] }
        this.utils = new Helpers()
        this.workers = new TaskBase(this)
        this.searchManager = new SearchOrchestrator(this)
        this.browser = {
            func: new PageController(this),
            utils: new AutomationUtils(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
        this.exitedWorkers = []
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    pushDashboardLog(entry: DashboardLog): void {
        this.dashboardEvents.push(entry)
        if (this.dashboardEvents.length > 500) {
            this.dashboardEvents.splice(0, this.dashboardEvents.length - 500)
        }
        this.agentRuntime.publishLog(entry)
        this.localControlServer?.publishLog(entry)
    }

    showPasswordlessPrompt(input: PasswordlessAuthPromptInput): void {
        const prompt: PasswordlessAuthPrompt = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            startedAt: new Date().toISOString(),
            ...input
        }
        this.passwordlessPrompt = prompt
        this.localControlServer?.publishEvent('passwordless-prompt', prompt)
    }

    clearPasswordlessPrompt(): void {
        if (!this.passwordlessPrompt) {
            return
        }

        const id = this.passwordlessPrompt.id
        this.passwordlessPrompt = null
        this.localControlServer?.publishEvent('passwordless-prompt-clear', { id })
    }

    applyConfig(config: Config): void {
        this.config = config
        this.activeWorkers = config.clusters
    }

    async reloadAccounts(): Promise<void> {
        this.accounts = loadAccounts()
    }

    getOpenDesktopSessions(): string[] {
        return [...this.desktopViewerSessions.keys()]
    }

    isDesktopSessionOpen(email: string): boolean {
        return this.desktopViewerSessions.has(email.toLowerCase())
    }

    isMobileSessionOpen(email: string): boolean {
        return this.mobileViewerSessions.has(email.toLowerCase())
    }

    isViewerSessionOpen(email: string): boolean {
        const key = email.toLowerCase()
        return this.desktopViewerSessions.has(key) || this.mobileViewerSessions.has(key)
    }

    getViewerSessionPlatform(email: string): 'desktop' | 'mobile' | null {
        const key = email.toLowerCase()
        if (this.mobileViewerSessions.has(key)) {
            return 'mobile'
        }
        if (this.desktopViewerSessions.has(key)) {
            return 'desktop'
        }
        return null
    }

    async openDesktopSession(email: string, target: 'rewards' | 'bing' = 'rewards'): Promise<void> {
        return this.openViewerSession(email, 'desktop', target)
    }

    async openMobileSession(email: string, target: 'rewards' | 'bing' = 'rewards'): Promise<void> {
        return this.openViewerSession(email, 'mobile', target)
    }

    private async openViewerSession(
        email: string,
        platform: 'desktop' | 'mobile',
        target: 'rewards' | 'bing' = 'rewards'
    ): Promise<void> {
        if (this.dashboardRunState === 'running' || this.dashboardRunState === 'checking') {
            throw new Error('Stop the current run before opening a browser session')
        }

        const account = this.accounts.find(entry => entry.email.toLowerCase() === email.toLowerCase())
        if (!account) {
            throw new Error(`Account not found: ${email}`)
        }

        const key = account.email.toLowerCase()
        if (this.isViewerSessionOpen(key)) {
            const openPlatform = this.getViewerSessionPlatform(key)
            throw new Error(
                openPlatform
                    ? `${openPlatform === 'mobile' ? 'Mobile' : 'Desktop'} session already open for this account`
                    : 'Browser session already open for this account'
            )
        }

        const logTag = platform === 'mobile' ? 'MOBILE-VIEWER' : 'DESKTOP-VIEWER'
        this.logger.info('main', logTag, `Opening visible ${platform} browser for ${account.email}`)

        const sessions = platform === 'mobile' ? this.mobileViewerSessions : this.desktopViewerSessions

        void executionContext.run({ isMobile: platform === 'mobile', account }, async () => {
            try {
                const session = await this.browserFactory.createBrowser(account, { headless: false })
                const page = await session.context.newPage()
                const openUrl =
                    target === 'bing'
                        ? 'https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F'
                        : this.config.baseURL
                await page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})

                sessions.set(key, session.context)
                this.logger.info(
                    'main',
                    logTag,
                    target === 'bing'
                        ? `Bing sign-in browser ready for ${account.email} — sign in manually, then close the window`
                        : `${platform === 'mobile' ? 'Mobile' : 'Desktop'} browser ready for ${account.email} — close the window when finished`
                )

                session.context.on('close', () => {
                    sessions.delete(key)
                    this.logger.info('main', logTag, `Browser closed for ${account.email}`)
                })
            } catch (error) {
                sessions.delete(key)
                const message = error instanceof Error ? error.message : String(error)
                this.logger.error('main', logTag, `Failed to open browser for ${account.email}: ${message}`)
            }
        })
    }

    async closeDesktopSession(email: string): Promise<void> {
        return this.closeViewerSession(email, 'desktop')
    }

    async closeMobileSession(email: string): Promise<void> {
        return this.closeViewerSession(email, 'mobile')
    }

    async closeViewerSession(email: string, platform?: 'desktop' | 'mobile'): Promise<void> {
        const key = email.toLowerCase()
        const resolvedPlatform = platform ?? this.getViewerSessionPlatform(key)
        if (!resolvedPlatform) {
            throw new Error('No open browser session for this account')
        }

        const sessions = resolvedPlatform === 'mobile' ? this.mobileViewerSessions : this.desktopViewerSessions
        const context = sessions.get(key)
        if (!context) {
            throw new Error(`No open ${resolvedPlatform} session for this account`)
        }

        await context.close().catch(() => undefined)
        sessions.delete(key)
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()

        // Load plugins from plugins/ directory
        await this.pluginManager.loadPlugins()

        // Install plugin-registered tasks into ActivityRunner
        const tasks = this.pluginManager.getRegisteredTasks()
        this.activities.installPremiumTasks(tasks)

        // Notify plugins that bot is initialized
        await this.pluginManager.notifyBotInitialized()
    }

    async run(): Promise<number> {
        if (cluster.isWorker) {
            this.runWorker()
            return 0
        }

        const accountsToRun = this.resolveAccountsToRun()
        if (!accountsToRun) {
            return 1
        }

        if (accountsToRun.length === 0) {
            this.logger.info(
                'main',
                'RUN-SKIP',
                this.localRunBypassFinishedFilter
                    ? 'No accounts left to run — selection was empty or invalid'
                    : 'No accounts left to run — all enabled accounts already finished today (select accounts in Run modal to re-run them)'
            )
            return 0
        }

        const totalAccounts = accountsToRun.length
        const runStartTime = Date.now()
        const clusterCount = totalAccounts === 1 ? 1 : this.config.clusters

        if (clusterCount > 1) {
            if (cluster.isPrimary) {
                this.logRunStart(totalAccounts, clusterCount)
                return this.runMaster(accountsToRun, runStartTime)
            }

            this.runWorker(runStartTime)
            return 0
        } else {
            this.logRunStart(totalAccounts, clusterCount)
            this.resetClusterRunState(totalAccounts, 1)
            await this.runTasks(accountsToRun, runStartTime)
            return 0
        }
    }

    private filterAccountsFinishedToday(accounts: Account[]): Account[] {
        const finishedToday = getAccountsFinishedToday()
        if (!finishedToday.size) {
            return accounts
        }

        const pending = accounts.filter(account => !finishedToday.has(account.email.toLowerCase()))
        const skipped = accounts.length - pending.length

        if (skipped > 0) {
            this.logger.info(
                'main',
                'RUN-FILTER',
                `Skipping ${skipped} account(s) already finished today before cluster assignment`
            )

            for (const account of accounts) {
                if (finishedToday.has(account.email.toLowerCase())) {
                    this.logger.debug('main', 'RUN-FILTER', `  - ${account.email}`)
                }
            }
        }

        return pending
    }

    private resolveAccountsToRun(): Account[] | null {
        const cliSelector = getCliAccountSelector()

        if (this.localRunAccountList?.length) {
            const selected: Account[] = []
            const missing: string[] = []

            for (const email of this.localRunAccountList) {
                const account = this.accounts.find(entry => entry.email.toLowerCase() === email.toLowerCase())
                if (account) {
                    selected.push(account)
                } else {
                    missing.push(email)
                }
            }

            if (missing.length) {
                this.logger.warn(
                    'main',
                    'CONTROL-PANEL',
                    `Run selection includes unknown account(s): ${missing.join(', ')}`
                )
            }

            if (!selected.length) {
                this.logger.error('main', 'CONTROL-PANEL', 'No valid accounts in run selection')
                return null
            }

            const disabled = selected.filter(account => account.enabled === false)
            if (disabled.length) {
                this.logger.info(
                    'main',
                    'CONTROL-PANEL',
                    `Running ${disabled.length} disabled account(s) from manual selection`
                )
            }

            this.logger.info('main', 'CONTROL-PANEL', `Manual run selection: ${selected.length} account(s) (finished-today filter skipped)`)
            return selected
        }

        if (this.localRunBypassFinishedFilter) {
            const enabledAccounts = this.accounts.filter(account => account.enabled !== false)
            this.logger.info(
                'main',
                'CONTROL-PANEL',
                `Manual run: ${enabledAccounts.length} enabled account(s) (finished-today filter skipped)`
            )
            return enabledAccounts
        }

        const accountSelector = this.localRunAccountSelector ?? cliSelector

        if (!accountSelector) {
            const enabledAccounts = this.accounts.filter(account => account.enabled !== false)
            return this.filterAccountsFinishedToday(enabledAccounts)
        }

        const matches = findAccountsBySelector(this.accounts, accountSelector)
        if (matches.length > 1) {
            this.logger.error(
                'main',
                'CLI',
                `Multiple accounts match "${accountSelector}". Use the full email address.`
            )
            for (const account of matches) {
                this.logger.error('main', 'CLI', `  - ${account.email}`)
            }
            return null
        }

        const selectedAccount = findAccountBySelector(this.accounts, accountSelector)
        if (!selectedAccount) {
            this.logger.error('main', 'CLI', `Account not found: ${accountSelector}`)
            this.logger.error('main', 'CLI', 'Available accounts:')
            for (const account of this.accounts) {
                if (account.email) {
                    this.logger.error('main', 'CLI', `  - ${account.email}`)
                }
            }
            return null
        }

        if (selectedAccount.enabled === false) {
            this.logger.warn(
                'main',
                'CLI',
                `Running disabled account because --account was specified: ${selectedAccount.email}`
            )
        }

        const source = this.localRunAccountSelector ? 'CONTROL-PANEL' : 'CLI'
        this.logger.info('main', source, `Single-account mode: ${selectedAccount.email}`)
        return [selectedAccount]
    }

    private logRunStart(totalAccounts: number, clusterCount = this.config.clusters): void {
        const accountSelector = getCliAccountSelector()
        const edition = this.pluginManager.hasOfficialCoreEntitlement() ? 'Core Edition' : 'Open Source Edition'

        renderRunPlan({
            version: pkg.version,
            edition,
            totalAccounts: this.accounts.length,
            enabledAccounts: totalAccounts,
            clusters: clusterCount,
            headless: this.config.headless,
            workers: this.config.workers,
            singleAccount: accountSelector
                ? findAccountBySelector(this.accounts, accountSelector)?.email ?? accountSelector
                : undefined
        })

        const singleAccountMode = accountSelector ? ' | Mode: single-account' : ''
        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${clusterCount}${singleAccountMode}`
        )
    }

    private logRunAccountSummary(expectedAccounts: Account[], accountStats: AccountStats[]): string {
        const statsByEmail = new Map(accountStats.map(stat => [stat.email, stat]))
        const summaryLines: string[] = []
        const tableRows = []

        for (const account of expectedAccounts) {
            const stat = statsByEmail.get(account.email)

            if (!stat) {
                const line = `MISSING | not reported by any worker | ${account.email}`
                summaryLines.push(line)
                tableRows.push({
                    email: account.email,
                    success: false,
                    collectedPoints: 0,
                    initialPoints: 0,
                    finalPoints: 0,
                    duration: 0,
                    missing: true
                })
                continue
            }

            if (stat.success) {
                const line = `OK | +${stat.collectedPoints} pts | ${stat.initialPoints} → ${stat.finalPoints} | ${stat.duration}s | ${stat.email}`
                summaryLines.push(line)
                tableRows.push({
                    email: stat.email,
                    success: true,
                    collectedPoints: stat.collectedPoints,
                    initialPoints: stat.initialPoints,
                    finalPoints: stat.finalPoints,
                    duration: stat.duration
                })
                continue
            }

            const line = `FAILED | ${stat.error ?? 'unknown error'} | ${stat.duration}s | ${stat.email}`
            summaryLines.push(line)
            tableRows.push({
                email: stat.email,
                success: false,
                collectedPoints: stat.collectedPoints,
                initialPoints: stat.initialPoints,
                finalPoints: stat.finalPoints,
                duration: stat.duration,
                error: stat.error ?? 'unknown error'
            })
        }

        renderRunSummaryTable(tableRows)
        void this.logger.info(
            'main',
            'RUN-SUMMARY',
            `Account status (${accountStats.length}/${expectedAccounts.length} reported)`
        )

        return summaryLines.join('\n')
    }

    resetClusterRunState(totalAccounts: number, workerCount: number): void {
        this.clusterWorkers.clear()
        this.clusterRunProgress = {
            totalAccounts,
            completedAccounts: 0,
            queuedAccounts: totalAccounts,
            activeWorkers: workerCount,
            configuredWorkers: workerCount
        }

        for (let workerId = 1; workerId <= workerCount; workerId++) {
            this.clusterWorkers.set(workerId, {
                workerId,
                pid: 0,
                account: null,
                phase: 'idle',
                completedCount: 0,
                updatedAt: new Date().toISOString()
            })
        }
    }

    reportClusterWorkerPhase(phase: ClusterWorkerPhase, accountEmail: string | null = null): void {
        const workerId = cluster.isWorker ? this.clusterWorkerId : 1
        const status: ClusterWorkerStatus = {
            workerId,
            pid: process.pid,
            account: accountEmail,
            phase,
            completedCount: this.clusterWorkerLocalCompleted,
            updatedAt: new Date().toISOString()
        }

        if (cluster.isWorker && process.send) {
            process.send({ __workerStatus: status })
            return
        }

        this.clusterWorkers.set(workerId, status)
    }

    private markClusterAccountCompleted(): void {
        this.clusterWorkerLocalCompleted++
        if (this.clusterRunProgress) {
            this.clusterRunProgress.completedAccounts++
            this.clusterRunProgress.queuedAccounts = Math.max(
                0,
                this.clusterRunProgress.totalAccounts - this.clusterRunProgress.completedAccounts
            )
        }
    }

    private async runMaster(accounts: Account[], runStartTime: number): Promise<number> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        const workerCount = Math.min(this.config.clusters, accounts.length)
        const queue = [...accounts]
        this.resetClusterRunState(accounts.length, workerCount)
        this.activeWorkers = workerCount
        this.exitedWorkers = []

        const allAccountStats: AccountStats[] = []
        const workerStatsReceived = new Map<number, number>()
        const expectedAccounts = accounts.length
        const workers: Worker[] = []

        if (workerCount === 0) {
            this.logger.warn('main', 'CLUSTER-PRIMARY', 'No workers to spawn')
            return 0
        }

        void this.logger.info(
            'main',
            'CLUSTER-PRIMARY',
            `Spawning ${workerCount} worker(s) | Queue: ${accounts.length} account(s) — assigning accounts as workers become ready`
        )

        const readyWorkers = new Set<Worker>()

        const attachWorkerHandlers = (worker: Worker): void => {
            worker.on('message', (msg: ClusterIpcFromWorker) => {
                if (msg.__ready) {
                    readyWorkers.add(worker)
                    return
                }

                if (msg.__workerStatus) {
                    this.clusterWorkers.set(msg.__workerStatus.workerId, msg.__workerStatus)
                    return
                }

                if (msg.__accountDone) {
                    allAccountStats.push(msg.__accountDone)
                    const workerPid = worker.process?.pid
                    if (workerPid) {
                        workerStatsReceived.set(workerPid, (workerStatsReceived.get(workerPid) ?? 0) + 1)
                    }
                    if (this.clusterRunProgress) {
                        this.clusterRunProgress.completedAccounts = allAccountStats.length
                    }

                    const next = queue.shift() ?? null
                    if (this.clusterRunProgress) {
                        this.clusterRunProgress.queuedAccounts = queue.length
                    }
                    worker.send?.({ __work: next } satisfies ClusterIpcToWorker)
                    return
                }

                if (msg.__pullWork) {
                    const next = queue.shift() ?? null
                    if (this.clusterRunProgress) {
                        this.clusterRunProgress.queuedAccounts = queue.length
                    }
                    worker.send?.({ __work: next } satisfies ClusterIpcToWorker)
                    return
                }

                const log = msg.__ipcLog

                if (log && typeof log.content === 'string') {
                    const config = this.config
                    const webhook = config.webhook
                    const content = log.content
                    const level = log.level
                    if (webhook.discord?.enabled && webhook.discord.url) {
                        sendDiscord(webhook.discord.url, content, level)
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        sendNtfy(webhook.ntfy, content, level)
                    }
                }
            })
        }

        for (let workerId = 1; workerId <= workerCount; workerId++) {
            const worker = cluster.fork()
            workers.push(worker)
            attachWorkerHandlers(worker)
        }

        const readyResults = await Promise.all(
            workers.map(async (worker, index) => {
                try {
                    await this.waitForWorkerReady(worker, readyWorkers)
                    return { worker, workerId: index + 1, ok: true as const }
                } catch (error) {
                    this.logger.error(
                        'main',
                        'CLUSTER-PRIMARY',
                        `Worker ${worker.process?.pid ?? '?'} failed to become ready: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    )
                    return { worker, workerId: index + 1, ok: false as const }
                }
            })
        )

        let assignedWorkers = 0
        for (const result of readyResults) {
            if (!result.ok) {
                continue
            }

            const initialAccount = queue.shift() ?? null
            if (this.clusterRunProgress) {
                this.clusterRunProgress.queuedAccounts = queue.length
            }

            result.worker.send?.({
                __init: {
                    workerId: result.workerId,
                    runStartTime,
                    ignoreTempBan: this.localRunIgnoreTempBan,
                    initialAccount
                }
            } satisfies ClusterIpcToWorker)

            assignedWorkers++
            void this.logger.info(
                'main',
                'CLUSTER-PRIMARY',
                `Worker ${result.worker.process?.pid ?? '?'} (#${result.workerId}) ready — assigned ${
                    initialAccount?.email ?? 'no account'
                } (${queue.length} still queued)`
            )
        }

        if (assignedWorkers < workerCount) {
            this.logger.warn(
                'main',
                'CLUSTER-PRIMARY',
                `Only ${assignedWorkers}/${workerCount} worker(s) started — ${queue.length} account(s) remain queued for active workers`
            )
            if (this.clusterRunProgress) {
                this.clusterRunProgress.activeWorkers = assignedWorkers
                this.clusterRunProgress.configuredWorkers = assignedWorkers
            }
            this.activeWorkers = assignedWorkers
        }

        return new Promise(resolve => {
            const onWorkerDone = async (label: 'exit' | 'disconnect', worker: Worker, code?: number): Promise<void> => {
                const workerPid = worker.process?.pid

                if (!workerPid || this.exitedWorkers.includes(workerPid)) {
                    return
                }

                this.exitedWorkers.push(workerPid)
                this.activeWorkers -= 1
                const reportedStats = workerPid ? workerStatsReceived.get(workerPid) : undefined

                if (this.clusterRunProgress) {
                    this.clusterRunProgress.activeWorkers = this.activeWorkers
                }

                this.logger.warn(
                    'main',
                    `CLUSTER-WORKER-${label.toUpperCase()}`,
                    `Worker ${workerPid ?? '?'} ${label} | Code: ${code ?? 'n/a'} | Stats: ${reportedStats ?? 0} account(s) | Active workers: ${this.activeWorkers}`
                )

                if (label === 'exit' && code !== undefined && code !== 0 && reportedStats === undefined) {
                    this.logger.error(
                        'main',
                        'CLUSTER-WORKER-ERROR',
                        `Worker ${workerPid ?? '?'} exited with code ${code} before reporting account stats`
                    )
                }

                if (this.activeWorkers <= 0) {
                    const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                    const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                    const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                    const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                    if (allAccountStats.length !== expectedAccounts) {
                        const missingAccounts = expectedAccounts - allAccountStats.length
                        this.logger.warn(
                            'main',
                            'RUN-END',
                            `Incomplete run: expected ${expectedAccounts} account(s), received stats for ${allAccountStats.length} (${missingAccounts} missing). Search logs for CLUSTER-WORKER-ERROR or workers with Stats: 0.`
                        )
                    }

                    renderRunEndBanner(
                        allAccountStats.length,
                        expectedAccounts,
                        totalCollectedPoints,
                        totalInitialPoints,
                        totalFinalPoints,
                        totalDurationMinutes
                    )
                    this.logger.info(
                        'main',
                        'RUN-END',
                        `Completed all accounts | Accounts processed: ${allAccountStats.length}/${expectedAccounts} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                        'green'
                    )
                    const accountSummary = this.logRunAccountSummary(accounts, allAccountStats)
                    await this.pluginManager.notify({
                        title: 'Run complete',
                        message: `Processed ${allAccountStats.length}/${expectedAccounts} account(s), collected +${totalCollectedPoints} points in ${totalDurationMinutes}min.\n\n${accountSummary}`,
                        level: 'info'
                    })
                    await flushAllWebhooks()
                    resolve(code ?? 0)
                }
            }

            cluster.on('exit', (worker, code) => {
                void onWorkerDone('exit', worker, code)
            })
            cluster.on('disconnect', worker => {
                void onWorkerDone('disconnect', worker, undefined)
            })
        })
    }

    private waitForWorkerReady(worker: Worker, readyWorkers?: Set<Worker>): Promise<void> {
        if (readyWorkers?.has(worker)) {
            readyWorkers.delete(worker)
            return Promise.resolve()
        }

        return new Promise((resolve, reject) => {
            const workerPid = worker.process?.pid ?? '?'
            const timeout = setTimeout(() => {
                worker.off('message', onReady)
                reject(new Error(`Worker ${workerPid} did not signal ready within 120s`))
            }, 120_000)

            const onReady = (msg: { __ready?: boolean }): void => {
                if (!msg?.__ready) {
                    return
                }

                clearTimeout(timeout)
                worker.off('message', onReady)
                readyWorkers?.delete(worker)
                resolve()
            }

            worker.on('message', onReady)

            if (readyWorkers?.has(worker)) {
                clearTimeout(timeout)
                worker.off('message', onReady)
                readyWorkers.delete(worker)
                resolve()
            }
        })
    }

    private runWorker(_runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `Worker spawned | PID: ${process.pid}`)
        let workerTaskStarted = false

        process.on('message', async (msg: ClusterIpcToWorker) => {
            if (!msg?.__init || workerTaskStarted) {
                return
            }

            workerTaskStarted = true
            this.clusterWorkerId = msg.__init.workerId
            this.clusterWorkerLocalCompleted = 0
            this.localRunIgnoreTempBan = msg.__init.ignoreTempBan === true

            void this.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `Worker ${process.pid} (#${msg.__init.workerId}) ready — starting with ${
                    msg.__init.initialAccount?.email ?? 'queue wait'
                }`
            )

            try {
                await this.runWorkerQueueLoop(msg.__init.runStartTime, msg.__init.initialAccount ?? null)
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `Worker task crash: ${error instanceof Error ? error.message : String(error)}`
                )
                await flushAllWebhooks()
                process.exit(1)
            }
        })

        if (process.send) {
            process.send({ __ready: true })
            void this.logger.debug('main', 'CLUSTER-WORKER-READY', `Worker ${process.pid} signaled ready to primary`)
        }
    }

    private waitForAssignedWork(): Promise<Account | null> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                process.off('message', onMsg)
                reject(new Error('Master did not assign work within 120s'))
            }, 120_000)

            const onMsg = (msg: ClusterIpcToWorker): void => {
                if (!msg || !('__work' in msg)) {
                    return
                }

                clearTimeout(timeout)
                process.off('message', onMsg)
                resolve(msg.__work ?? null)
            }

            process.on('message', onMsg)
        })
    }

    private async runWorkerQueueLoop(runStartTime: number, initialAccount: Account | null = null): Promise<void> {
        let account: Account | null = initialAccount

        while (true) {
            if (!account) {
                this.reportClusterWorkerPhase('idle', null)
                account = await this.waitForAssignedWork()
            }

            if (!account) {
                break
            }

            this.reportClusterWorkerPhase('starting', account.email)
            const result = await this.runSingleAccount(account, runStartTime)
            this.markClusterAccountCompleted()

            const nextWorkPromise = this.waitForAssignedWork()
            if (process.send) {
                process.send({ __accountDone: result })
                await new Promise<void>(resolve => setImmediate(resolve))
            }

            account = await nextWorkPromise
        }

        this.reportClusterWorkerPhase('idle', null)
        process.disconnect()
        process.exit(0)
    }

    private async runSingleAccount(account: Account, _runStartTime: number): Promise<AccountStats> {
        const accountStartTime = Date.now()
        const accountEmail = account.email
        this.userData.userName = this.utils.getEmailUsername(accountEmail)

        try {
            this.logger.info(
                'main',
                'ACCOUNT-START',
                `Starting account: ${accountEmail} | geoLocale: ${account.geoLocale}`
            )

            await this.pluginManager.notifyAccountStart(accountEmail)

            this.axios = new HttpClient(account.proxy)

            const result: { initialPoints: number; collectedPoints: number } | undefined = await this.Main(
                account
            ).catch(error => {
                maybeRecordStaleSession(accountEmail, error)
                void this.logger.error(
                    true,
                    'FLOW',
                    `Mobile flow failed for ${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                )
                return undefined
            })

            const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

            if (result) {
                const collectedPoints = result.collectedPoints ?? 0
                const accountInitialPoints = result.initialPoints ?? 0
                const accountFinalPoints = accountInitialPoints + collectedPoints

                this.logger.info(
                    'main',
                    'ACCOUNT-END',
                    `Completed account: ${accountEmail} | Total: +${collectedPoints} | Old: ${accountInitialPoints} → New: ${accountFinalPoints} | Duration: ${durationSeconds}s`,
                    'green'
                )

                await this.pluginManager.notifyAccountEnd(accountEmail, {
                    email: accountEmail,
                    initialPoints: accountInitialPoints,
                    finalPoints: accountFinalPoints,
                    collectedPoints: collectedPoints,
                    duration: parseFloat(durationSeconds),
                    success: true
                })

                recordAccountRun({
                    email: accountEmail,
                    success: true,
                    completedAt: new Date().toISOString(),
                    collectedPoints,
                    initialPoints: accountInitialPoints,
                    finalPoints: accountFinalPoints,
                    durationSeconds: parseFloat(durationSeconds),
                    level:
                        getAccountDashboardSnapshot(accountEmail)?.level ??
                        this.userData.dashboardInfo?.level ??
                        null
                })
                clearAccountStaleSession(accountEmail)

                return {
                    email: accountEmail,
                    initialPoints: accountInitialPoints,
                    finalPoints: accountFinalPoints,
                    collectedPoints: collectedPoints,
                    duration: parseFloat(durationSeconds),
                    success: true
                }
            }

            const failedResult: AccountStats = {
                email: accountEmail,
                initialPoints: 0,
                finalPoints: 0,
                collectedPoints: 0,
                duration: parseFloat(durationSeconds),
                success: false,
                error: 'Flow failed'
            }
            await this.pluginManager.notifyAccountEnd(accountEmail, failedResult)
            recordAccountRun({
                email: accountEmail,
                success: false,
                completedAt: new Date().toISOString(),
                collectedPoints: 0,
                durationSeconds: parseFloat(durationSeconds),
                level: getAccountDashboardSnapshot(accountEmail)?.level ?? this.userData.dashboardInfo?.level ?? null
            })
            return failedResult
        } catch (error) {
            const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
            maybeRecordStaleSession(accountEmail, error)
            const failedResult: AccountStats = {
                email: accountEmail,
                initialPoints: 0,
                finalPoints: 0,
                collectedPoints: 0,
                duration: parseFloat(durationSeconds),
                success: false,
                error: error instanceof Error ? error.message : String(error)
            }
            this.logger.error(
                'main',
                'ACCOUNT-ERROR',
                `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
            )

            await this.pluginManager.notifyAccountEnd(accountEmail, failedResult)
            recordAccountRun({
                email: accountEmail,
                success: false,
                completedAt: new Date().toISOString(),
                collectedPoints: 0,
                durationSeconds: parseFloat(durationSeconds),
                level: getAccountDashboardSnapshot(accountEmail)?.level ?? null
            })
            return failedResult
        }
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []

        for (const account of accounts) {
            this.reportClusterWorkerPhase('starting', account.email)
            const result = await this.runSingleAccount(account, runStartTime)
            accountStats.push(result)
            this.markClusterAccountCompleted()
            this.reportClusterWorkerPhase('idle', null)
        }

        if (this.config.clusters <= 1 && !cluster.isWorker) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            renderRunEndBanner(
                accountStats.length,
                accounts.length,
                totalCollectedPoints,
                totalInitialPoints,
                totalFinalPoints,
                totalDurationMinutes
            )
            this.logger.info(
                'main',
                'RUN-END',
                `Completed all accounts | Accounts processed: ${accountStats.length}/${accounts.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                'green'
            )

            const accountSummary = this.logRunAccountSummary(accounts, accountStats)
            await this.pluginManager.notify({
                title: 'Run complete',
                message: `Processed ${accountStats.length}/${accounts.length} account(s), collected +${totalCollectedPoints} points in ${totalDurationMinutes}min.\n\n${accountSummary}`,
                level: 'info'
            })

            await flushAllWebhooks()
        }

        return accountStats
    }

    async Main(account: Account): Promise<{ initialPoints: number; collectedPoints: number }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                // Set a tablet-sized viewport for a comfortable visual while keeping mobile UA
                await this.mainMobilePage.setViewportSize({ width: 768, height: 1024 })

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

                this.reportClusterWorkerPhase('login', accountEmail)
                await this.login.login(this.mainMobilePage, account)

                const needsAppAccessToken =
                    this.config.workers.doAppPromotions ||
                    this.config.workers.doDailyCheckIn ||
                    this.config.workers.doReadToEarn

                if (needsAppAccessToken) {
                    try {
                        this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, account)
                    } catch (error) {
                        this.logger.error(
                            'main',
                            'FLOW',
                            `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
                        )
                    }
                } else {
                    this.logger.debug(
                        'main',
                        'GET-APP-TOKEN',
                        'Skipping mobile access token: no app-only workers enabled'
                    )
                }

                await this.login.ensureRewardsWebSession(this.mainMobilePage, account)
                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = mobileSession.fingerprint

                this.reportClusterWorkerPhase('dashboard', accountEmail)
                const data: DashboardData = await this.browser.func.getDashboardData()
                const appData: AppDashboardData = await this.browser.func.getAppDashboardData()

                // Set geo
                this.userData.geoLocale =
                    account.geoLocale === 'auto' ? data.userProfile.attributes.country : account.geoLocale.toLowerCase()
                if (this.userData.geoLocale.length > 2) {
                    this.logger.warn(
                        'main',
                        'GEO-LOCALE',
                        `The provided geoLocale is longer than 2 (${this.userData.geoLocale} | auto=${account.geoLocale === 'auto'}), this is likely invalid and can cause errors!`
                    )
                }

                this.userData.initialPoints = data.userStatus.availablePoints
                this.userData.currentPoints = data.userStatus.availablePoints
                const initialPoints = this.userData.initialPoints ?? 0

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints()
                const appEarnable = await this.browser.func.getAppEarnablePoints()

                this.pointsCanCollect = browserEarnable.mobileSearchPoints + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info(
                    'main',
                    'POINTS',
                    `Earnable today | Mobile: ${this.pointsCanCollect} | Browser: ${
                        browserEarnable.mobileSearchPoints
                    } | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.userData.geoLocale}`
                )

                // Claim ready dashboard points before spending time on other activities.
                if (this.config.workers.doClaimPoints) {
                    this.reportClusterWorkerPhase('claim', accountEmail)
                    const claimResult = await this.activities.doClaimPoints(this.mainMobilePage)
                    if (claimResult.claimed && claimResult.pointsClaimed > 0) {
                        this.logger.info(
                            'main',
                            'CLAIM-POINTS',
                            `Claimed ${claimResult.pointsClaimed} points | Entries: ${claimResult.entries.length}`
                        )
                    }
                }

                // Dashboard Info: collect hero data BEFORE any activities (for before/after comparison)
                if (this.config.workers.doDashboardInfo) {
                    const dashInfo = await this.activities.collectDashboardInfo(this.mainMobilePage)
                    this.userData.dashboardInfo = dashInfo
                    this.logger.info(
                        'main',
                        'DASHBOARD-INFO',
                        `User: ${dashInfo.userName ?? 'unknown'} | Level: ${dashInfo.level ?? 'unknown'} | Points: ${
                            dashInfo.availablePoints ?? 0
                        } | Today: ${dashInfo.todayPoints ?? 0} | Streak: ${dashInfo.streakDays ?? 0} | Ready to claim: ${
                            dashInfo.readyToClaimPoints
                        }${dashInfo.hasClaimEntryExpiringSoon ? ' | Claim expiring soon' : ''}`
                    )
                }

                if (this.config.workers.doAppPromotions) await this.workers.doAppPromotions(appData)
                this.reportClusterWorkerPhase('promotions', accountEmail)
                if (this.config.workers.doDailySet) await this.workers.doDailySet(data, this.mainMobilePage)
                if (this.config.workers.doSpecialPromotions) await this.workers.doSpecialPromotions(data)
                if (this.config.workers.doMorePromotions) {
                    await this.workers.doMorePromotions(data, this.mainMobilePage)
                    if (this.pluginManager.hasOfficialCoreEntitlement()) {
                        await this.activities.doTemporaryPunchcards(this.mainMobilePage)
                    }
                }
                if (this.accessToken) {
                    if (this.config.workers.doDailyCheckIn) {
                        await this.activities.doDailyCheckIn(this.mainMobilePage)
                    }
                    if (this.config.workers.doReadToEarn) await this.activities.doReadToEarn()
                } else if (this.config.workers.doDailyCheckIn || this.config.workers.doReadToEarn) {
                    this.logger.warn(
                        'main',
                        'APP-ACTIVITIES',
                        'Skipping app-only activities because the mobile access token was not available'
                    )
                }

                // Daily Streak: expand progression, activate protection, read bonus info
                let streakDaysFromActivity: number | null = null
                if (this.config.workers.doDailyStreak) {
                    const streakInfo = await this.activities.doDailyStreak(this.mainMobilePage)
                    if (streakInfo) {
                        streakDaysFromActivity = streakInfo.streakDays
                        this.logger.info(
                            'main',
                            'DAILY-STREAK',
                            `Streak: ${streakInfo.streakDays} days | Protection: ${streakInfo.streakProtectionEnabled ? 'ON' : 'OFF'} | Bonus: ${streakInfo.bonusText ?? 'N/A'} (${streakInfo.bonusStarsFilled}/${streakInfo.bonusStarsTotal} stars)`
                        )
                    }
                }

                if (this.config.workers.enforceCoreStreakProtectionGate) {
                    await this.activities.syncStreakProtection(this.mainMobilePage, true)
                }

                // Redeem Goal: set auto-redeem goal if configured
                if (this.config.workers.doRedeemGoal && this.config.redeemGoal?.enabled) {
                    await this.activities.doRedeemGoal(this.mainMobilePage, this.config.redeemGoal)
                }

                if (this.config.workers.doDashboardInfo) {
                    const refreshed = await this.activities.refreshDashboardSnapshot(
                        this.userData.dashboardInfo,
                        streakDaysFromActivity
                    )
                    this.userData.dashboardInfo = refreshed
                    saveAccountDashboardSnapshot(accountEmail, refreshed)
                    this.logger.info(
                        'main',
                        'DASHBOARD-INFO',
                        `Snapshot saved | Level: ${refreshed.level ?? 'unknown'} | Streak: ${
                            refreshed.streakDays ?? 0
                        }d | Daily set: ${refreshed.dailySetCompleted ?? '?'}/${refreshed.dailySetTotal ?? '?'} | Points: ${
                            refreshed.availablePoints ?? 0
                        }`
                    )
                }

                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)

                this.cookies.mobile = await initialContext.cookies()

                this.reportClusterWorkerPhase('searches', accountEmail)
                const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(
                    data,
                    missingSearchPoints,
                    mobileSession,
                    account,
                    accountEmail
                )

                mobileContextClosed = true

                this.userData.gainedPoints = mobilePoints + desktopPoints

                this.reportClusterWorkerPhase('finishing', accountEmail)
                const finalPoints = await this.browser.func.getCurrentPoints()
                const collectedPoints = finalPoints - initialPoints

                this.logger.info(
                    'main',
                    'FLOW',
                    `Collected: +${collectedPoints} | Mobile: +${mobilePoints} | Desktop: +${desktopPoints} | ${accountEmail}`
                )

                return {
                    initialPoints,
                    collectedPoints: collectedPoints || 0
                }
            })
        } finally {
            if (mobileSession && !mobileContextClosed) {
                try {
                    await executionContext.run({ isMobile: true, account }, async () => {
                        await this.browser.func.closeBrowser(mobileSession!.context, accountEmail)
                    })
                } catch {}
            }
        }
    }
}

async function main(): Promise<void> {
    checkNodeVersion()
    if (process.env.MSRB_LAUNCHED_VIA_START !== '1') {
        renderStartupBanner(pkg.version, 'Open Source Edition')
    }

    if (process.argv.includes('--attach')) {
        process.exit(await attachToAgent())
    }

    if (!cluster.isWorker && (await isAgentActive())) {
        if (process.argv.includes('--stop-existing')) {
            const stopped = await stopExistingAgent()
            if (!stopped) {
                console.error('[AGENT] Existing instance did not stop in time.')
                process.exit(1)
            }
        } else if (await confirmReplaceExistingAgent()) {
            const stopped = await stopExistingAgent()
            if (!stopped) {
                console.error('[AGENT] Existing instance did not stop in time.')
                process.exit(1)
            }
        } else {
            console.log('[AGENT] Existing instance left running. Exiting this launch.')
            process.exit(0)
        }
    }

    const rewardsBot = new MicrosoftRewardsBot()

    const stopControlPanel = async (): Promise<void> => {
        if (rewardsBot.localControlServer) {
            await rewardsBot.localControlServer.stop()
            rewardsBot.localControlServer = null
        }
    }

    process.on('beforeExit', () => {
        void rewardsBot.agentRuntime.stop()
        void stopControlPanel()
        void rewardsBot.pluginManager.destroyAll()
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...')
        await rewardsBot.agentRuntime.stop()
        await stopControlPanel()
        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...')
        await rewardsBot.agentRuntime.stop()
        await stopControlPanel()
        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await rewardsBot.agentRuntime.stop()
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await rewardsBot.agentRuntime.stop()
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        if (!cluster.isWorker && rewardsBot.config.backgroundAgent?.enabled !== false) {
            await rewardsBot.agentRuntime.start()
        }
        await rewardsBot.initialize()
        if (cluster.isWorker) {
            await rewardsBot.run()
            return
        }

        const exitCode = rewardsBot.config.controlPanel?.enabled
            ? await runControlPanelLoop(rewardsBot)
            : process.argv.includes('--background') && !isSchedulerEnabled(rewardsBot.config.scheduler)
            ? await runBackgroundAgent(rewardsBot)
            : isSchedulerEnabled(rewardsBot.config.scheduler)
            ? await runScheduled(rewardsBot)
            : await runSingle(rewardsBot)

        await stopControlPanel()
        await rewardsBot.agentRuntime.stop()
        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(exitCode)
    } catch (error) {
        rewardsBot.dashboardRunState = 'error'
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
        await rewardsBot.agentRuntime.stop()
        await flushAllWebhooks()
    }
}

async function waitForControlPanelTrigger(rewardsBot: MicrosoftRewardsBot, until?: Date): Promise<void> {
    while (!rewardsBot.localRunRequested && !rewardsBot.dashboardStopRequested) {
        if (until && Date.now() >= until.getTime()) {
            return
        }

        const waitMs = until ? Math.min(until.getTime() - Date.now(), 500) : 500
        await new Promise(resolve => setTimeout(resolve, Math.max(waitMs, 50)))
    }
}

async function runControlPanelLoop(rewardsBot: MicrosoftRewardsBot): Promise<number> {
    const controlPanel = rewardsBot.config.controlPanel
    if (!controlPanel?.enabled) {
        return runSingle(rewardsBot)
    }

    rewardsBot.localControlServer = new LocalControlServer(rewardsBot)
    await rewardsBot.localControlServer.start()

    const scheduler = rewardsBot.config.scheduler
    const schedulerActive = isSchedulerEnabled(scheduler)
    let shouldRunNow = controlPanel.runOnStartup !== false

    rewardsBot.dashboardRunState = 'idle'
    rewardsBot.logger.info(
        'main',
        'CONTROL-PANEL',
        schedulerActive
            ? 'Control panel active — manual runs and scheduler both enabled'
            : 'Control panel active — waiting for Run now or scheduler'
    )

    while (true) {
        if (rewardsBot.dashboardStopRequested) {
            rewardsBot.logger.info('main', 'CONTROL-PANEL', 'Stop requested. Exiting control panel loop.')
            return 0
        }

        if (shouldRunNow || rewardsBot.localRunRequested) {
            rewardsBot.localRunRequested = false
            const exitCode = await runSingle(rewardsBot)
            rewardsBot.localRunAccountSelector = null
            rewardsBot.localRunAccountList = null
            rewardsBot.localRunIgnoreTempBan = false
            rewardsBot.localRunBypassFinishedFilter = false
            rewardsBot.dashboardRunState = 'idle'

            if (rewardsBot.dashboardStopRequested) {
                rewardsBot.logger.info('main', 'CONTROL-PANEL', 'Stop requested after run. Exiting control panel loop.')
                return exitCode
            }

            shouldRunNow = false
            continue
        }

        rewardsBot.dashboardRunState = 'waiting'

        if (schedulerActive && scheduler) {
            const nextRun = getNextScheduledRun(scheduler)
            rewardsBot.logger.info(
                'main',
                'CONTROL-PANEL',
                `Waiting — next scheduled run ${formatScheduledRun(nextRun, scheduler.timezone)}`
            )
            await waitForControlPanelTrigger(rewardsBot, nextRun.target)
        } else {
            rewardsBot.logger.info('main', 'CONTROL-PANEL', 'Waiting — click Run now in the control panel')
            await waitForControlPanelTrigger(rewardsBot)
        }

        if (rewardsBot.dashboardStopRequested) {
            return 0
        }

        shouldRunNow = true
    }
}

async function runBackgroundAgent(rewardsBot: MicrosoftRewardsBot): Promise<number> {
    if (!rewardsBot.pluginManager.hasOfficialCoreEntitlement()) {
        rewardsBot.logger.warn('main', 'AGENT', 'Background agent requires Core with a valid license.')
        return 0
    }

    rewardsBot.dashboardRunState = 'idle'
    rewardsBot.logger.info('main', 'AGENT', 'Background agent connected. Waiting for dashboard commands.')
    await new Promise<void>(() => undefined)
    return 0
}

async function runSingle(rewardsBot: MicrosoftRewardsBot): Promise<number> {
    rewardsBot.dashboardRunState = 'checking'
    const canRun = await checkSafetyAdvisory(rewardsBot)
    if (!canRun) {
        rewardsBot.dashboardRunState = 'blocked'
        return 1
    }

    rewardsBot.dashboardRunState = 'running'
    const exitCode = await rewardsBot.run()
    rewardsBot.dashboardRunState = exitCode === 0 ? 'finished' : 'error'
    return exitCode
}

async function runScheduled(rewardsBot: MicrosoftRewardsBot): Promise<number> {
    const scheduler = rewardsBot.config.scheduler
    if (!scheduler) return runSingle(rewardsBot)

    rewardsBot.logger.info(
        'main',
        'SCHEDULER',
        `Scheduler enabled | timezone=${scheduler.timezone} | startTime=${scheduler.startTime} | runOnStartup=${scheduler.runOnStartup}`
    )

    let shouldRunNow = scheduler.runOnStartup

    while (true) {
        if (shouldRunNow) {
            const exitCode = await runSingle(rewardsBot)
            if (exitCode !== 0) return exitCode
            if (rewardsBot.dashboardStopRequested) {
                rewardsBot.logger.info(
                    'main',
                    'SCHEDULER',
                    'Remote stop requested. Scheduler will stop after the current run.'
                )
                return 0
            }
        }

        const nextRun = getNextScheduledRun(scheduler)
        rewardsBot.dashboardRunState = 'waiting'
        rewardsBot.logger.info(
            'main',
            'SCHEDULER',
            `Next run scheduled for ${formatScheduledRun(nextRun, scheduler.timezone)}`
        )

        await waitUntil(nextRun.target)
        shouldRunNow = true
    }
}

if (require.main === module) {
    main().catch(async error => {
        const tmpBot = new MicrosoftRewardsBot()
        tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
        await flushAllWebhooks()
        process.exit(1)
    })
}
