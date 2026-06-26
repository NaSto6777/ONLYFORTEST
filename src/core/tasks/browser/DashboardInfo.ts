import type { Page } from 'patchright'
import { URLS } from '../../../automation/DashboardSelectors'
import { extractNextFlightTextFromHtml } from '../../../automation/RewardsPageAnalyzer'
import type { ClaimEntry, DashboardInfo } from '../../InternalPluginAPI'
import { TaskBase } from '../../TaskBase'
import type { DashboardData } from '../../../types/DashboardData'

export class DashboardInfoCollector extends TaskBase {
    public async collectDashboardInfo(page: Page): Promise<DashboardInfo> {
        this.bot.logger.info(this.bot.isMobile, 'DASHBOARD-INFO', 'Collecting dashboard snapshot')

        try {
            const dashboard = await this.bot.browser.func.getDashboardData()
            let info = this.parseFromDashboard(dashboard)

            const claimData = await this.parseClaimDataFromBrowser(page)
            if (claimData.readyToClaimPoints > 0 || claimData.claimEntries.length > 0) {
                info = {
                    ...info,
                    readyToClaimPoints: claimData.readyToClaimPoints || info.readyToClaimPoints,
                    claimEntries: claimData.claimEntries.length ? claimData.claimEntries : info.claimEntries,
                    hasClaimEntryExpiringSoon: claimData.hasClaimEntryExpiringSoon
                }
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'DASHBOARD-INFO',
                `User: ${info.userName ?? 'unknown'} | Level: ${info.level ?? 'unknown'} | Points: ${
                    info.availablePoints ?? 0
                } | Today: ${info.todayPoints ?? 0} | Streak: ${info.streakDays ?? 0} | Daily set: ${
                    info.dailySetCompleted ?? '?'
                }/${info.dailySetTotal ?? '?'} | Ready to claim: ${info.readyToClaimPoints}`
            )

            return info
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DASHBOARD-INFO',
                `Failed: ${error instanceof Error ? error.message : String(error)}`
            )

            return this.emptyInfo()
        }
    }

    public async refreshDashboardSnapshot(
        prior: DashboardInfo | null,
        streakDaysOverride?: number | null
    ): Promise<DashboardInfo> {
        try {
            const dashboard = await this.bot.browser.func.getDashboardData()
            const refreshed = this.parseFromDashboard(dashboard)

            return {
                ...(prior ?? this.emptyInfo()),
                ...refreshed,
                readyToClaimPoints: prior?.readyToClaimPoints ?? refreshed.readyToClaimPoints,
                claimEntries: prior?.claimEntries ?? refreshed.claimEntries,
                hasClaimEntryExpiringSoon: prior?.hasClaimEntryExpiringSoon ?? refreshed.hasClaimEntryExpiringSoon,
                streakDays:
                    streakDaysOverride !== undefined && streakDaysOverride !== null
                        ? streakDaysOverride
                        : refreshed.streakDays ?? prior?.streakDays ?? null
            }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DASHBOARD-INFO',
                `Post-activity refresh failed: ${error instanceof Error ? error.message : String(error)}`
            )
            return prior ?? this.emptyInfo()
        }
    }

    private parseDailySetProgress(data: DashboardData): { completed: number; total: number } | null {
        const todayKey = this.bot.utils.getFormattedDate()
        const todayItems = data.dailySetPromotions?.[todayKey]?.filter(item => item.pointProgressMax > 0) ?? []
        if (!todayItems.length) {
            return null
        }

        return {
            total: todayItems.length,
            completed: todayItems.filter(item => item.complete).length
        }
    }

    private parseFromDashboard(data: DashboardData): DashboardInfo {
        const levelInfo = data.userStatus?.levelInfo
        const todayPoints =
            data.userStatus?.counters?.dailyPoint?.reduce((sum, counter) => sum + (counter.pointProgress ?? 0), 0) ??
            null
        const dailySet = this.parseDailySetProgress(data)
        const streakDays = Number.parseInt(data.streakProtectionPromo?.streakCount ?? '0', 10) || null

        return {
            userName: this.bot.userData.userName || null,
            level: levelInfo?.activeLevelName || levelInfo?.activeLevel || data.userProfile?.attributes?.level || null,
            levelKey: levelInfo?.activeLevel || null,
            availablePoints: data.userStatus?.availablePoints ?? null,
            readyToClaimPoints: 0,
            claimEntries: [],
            hasClaimEntryExpiringSoon: false,
            todayPoints: todayPoints && todayPoints > 0 ? todayPoints : null,
            streakDays,
            dailySetCompleted: dailySet?.completed ?? null,
            dailySetTotal: dailySet?.total ?? null
        }
    }

    public async getReadyToClaim(page: Page): Promise<{
        readyToClaimPoints: number
        claimEntries: ClaimEntry[]
        hasClaimEntryExpiringSoon: boolean
    }> {
        return this.parseClaimDataFromBrowser(page)
    }

    private async parseClaimDataFromBrowser(page: Page): Promise<{
        readyToClaimPoints: number
        claimEntries: ClaimEntry[]
        hasClaimEntryExpiringSoon: boolean
    }> {
        try {
            if (!page.url().includes('rewards.bing.com')) {
                await page.goto(URLS.dashboard, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
                await this.bot.utils.wait(1000)
            }

            const html = await page.content()
            const flightText = extractNextFlightTextFromHtml(html)
            return this.parsePointClaim(flightText || html)
        } catch {
            return { readyToClaimPoints: 0, claimEntries: [], hasClaimEntryExpiringSoon: false }
        }
    }

    private parsePointClaim(text: string): {
        readyToClaimPoints: number
        claimEntries: ClaimEntry[]
        hasClaimEntryExpiringSoon: boolean
    } {
        const claimContext = this.extractPointClaimContext(text)
        if (!claimContext) {
            return { readyToClaimPoints: 0, claimEntries: [], hasClaimEntryExpiringSoon: false }
        }

        const readyToClaimPoints = this.readNumberField(claimContext, 'points') ?? 0
        const claimEntries: ClaimEntry[] = []
        const entryMatches = claimContext.matchAll(
            /\{[^{}]*"category"\s*:\s*"([^"]+)"[^{}]*"points"\s*:\s*(\d+)[^{}]*\}/g
        )

        for (const match of entryMatches) {
            const entryContext = match[0]
            const expiryDate =
                this.readStringField(entryContext, 'expiryDate') ??
                this.readStringField(entryContext, 'expirationDate') ??
                this.readStringField(entryContext, 'validUntil') ??
                ''

            claimEntries.push({
                category: match[1] ?? 'unknown',
                date: this.readStringField(entryContext, 'date') ?? '',
                expiryDate,
                points: Number.parseInt(match[2] ?? '0', 10) || 0
            })
        }

        const hasClaimEntryExpiringSoon = claimEntries.some(entry => this.isExpiringSoon(entry.expiryDate))

        return {
            readyToClaimPoints: readyToClaimPoints || claimEntries.reduce((sum, entry) => sum + entry.points, 0),
            claimEntries,
            hasClaimEntryExpiringSoon
        }
    }

    private extractPointClaimContext(text: string): string | null {
        const marker = text.match(/"pointClaim"\s*:\s*\{/)
        if (!marker || marker.index === undefined) return null

        const start = marker.index + marker[0].length - 1
        let depth = 0

        for (let i = start; i < text.length; i++) {
            const char = text[i]
            if (char === '{') depth++
            if (char === '}') {
                depth--
                if (depth === 0) {
                    return text.slice(start, i + 1)
                }
            }
        }

        return null
    }

    private isExpiringSoon(expiryDate: string): boolean {
        if (!expiryDate) return false

        const parsed = Date.parse(expiryDate)
        if (Number.isNaN(parsed)) return false

        const daysUntilExpiry = (parsed - Date.now()) / (1000 * 60 * 60 * 24)
        return daysUntilExpiry >= 0 && daysUntilExpiry <= 7
    }

    private readStringField(context: string, field: string): string | undefined {
        const match = context.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`))
        return match?.[1]?.replace(/\\u0026/g, '&')
    }

    private readNumberField(context: string, field: string): number | undefined {
        const match = context.match(new RegExp(`"${field}"\\s*:\\s*(-?\\d+)`))
        return match?.[1] ? Number.parseInt(match[1], 10) : undefined
    }

    private emptyInfo(): DashboardInfo {
        return {
            userName: this.bot.userData.userName || null,
            level: null,
            levelKey: null,
            availablePoints: null,
            readyToClaimPoints: 0,
            claimEntries: [],
            hasClaimEntryExpiringSoon: false,
            todayPoints: null,
            streakDays: null,
            dailySetCompleted: null,
            dailySetTotal: null
        }
    }
}
