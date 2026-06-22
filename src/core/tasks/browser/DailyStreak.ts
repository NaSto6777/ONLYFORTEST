import type { Page } from 'patchright'
import { URLS } from '../../../automation/DashboardSelectors'
import { RewardsSidePanelController } from '../../../automation/RewardsSidePanelController'
import { extractNextFlightTextFromHtml } from '../../../automation/RewardsPageAnalyzer'
import type { DailyStreakInfo } from '../../InternalPluginAPI'
import { TaskBase } from '../../TaskBase'
import { GiveEligible, type DashboardData } from '../../../types/DashboardData'

export class DailyStreak extends TaskBase {
    public async doDailyStreak(page: Page): Promise<DailyStreakInfo | null> {
        this.bot.logger.info(this.bot.isMobile, 'DAILY-STREAK', 'Reading daily streak status')

        try {
            const dashboard = await this.bot.browser.func.getDashboardData()
            let info = this.parseFromDashboard(dashboard)

            if (this.needsBrowserFallback(info)) {
                const browserInfo = await this.parseFromBrowser(page)
                info = this.mergeInfo(info, browserInfo)
            }

            if (info.streakProtectionEnabled === null) {
                const protectionEnabled = await this.readProtectionFromPanel(page)
                if (protectionEnabled !== null) {
                    info.streakProtectionEnabled = protectionEnabled
                }
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-STREAK',
                `Streak: ${info.streakDays} days | Protection: ${
                    info.streakProtectionEnabled === null ? 'unknown' : info.streakProtectionEnabled ? 'ON' : 'OFF'
                } | Bonus: ${info.bonusText ?? 'N/A'} (${info.bonusStarsFilled}/${info.bonusStarsTotal} stars)`
            )

            return info
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-STREAK',
                `Failed: ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private parseFromDashboard(data: DashboardData): DailyStreakInfo {
        const protection = data.streakProtectionPromo
        const streakDays = Number.parseInt(protection?.streakCount ?? '0', 10) || 0
        const streakProtectionEnabled = this.parseProtectionStatus(protection?.streakProtectionStatus)

        const bonusPromo = data.streakBonusPromotions?.[0]
        const streakPromo = data.streakPromotion

        const bonusStarsFilled = this.parseProgress(
            bonusPromo?.activityProgress,
            bonusPromo?.attributes?.activity_progress,
            streakPromo?.activityProgress,
            streakPromo?.attributes?.activity_progress
        )

        const bonusStarsTotal = this.parseProgress(
            bonusPromo?.activityProgressMax,
            bonusPromo?.attributes?.activity_max,
            streakPromo?.activityProgressMax,
            streakPromo?.attributes?.lifetime_max
        )

        let bonusPoints = streakPromo?.bonusPointsEarned ?? 0
        if (!bonusPoints) {
            bonusPoints = Number.parseInt(streakPromo?.attributes?.bonus_points ?? '0', 10) || 0
        }
        if (!bonusPoints) {
            bonusPoints = Number.parseInt(bonusPromo?.attributes?.bonus_earned ?? '0', 10) || 0
        }

        const bonusText =
            bonusPoints > 0
                ? `+${bonusPoints} points`
                : bonusPromo?.title || streakPromo?.title || bonusPromo?.description || streakPromo?.description || null

        return {
            streakDays,
            streakProtectionEnabled,
            bonusText,
            bonusStarsFilled,
            bonusStarsTotal
        }
    }

    private async parseFromBrowser(page: Page): Promise<Partial<DailyStreakInfo>> {
        if (!page.url().includes('rewards.bing.com')) {
            await page.goto(URLS.dashboard, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
            await this.bot.utils.wait(1000)
        }

        const html = await page.content()
        const flightText = extractNextFlightTextFromHtml(html)
        const combined = `${html}\n${flightText}`

        const streakDays = this.readNumberFromText(combined, ['streakCounter', 'streakCount']) ?? 0
        const protectionRaw = this.readProtectionFromText(combined)
        const bonusStarsFilled =
            this.readNumberFromText(combined, ['activityProgress', 'activity_progress']) ?? 0
        const bonusStarsTotal =
            this.readNumberFromText(combined, ['activitiesTotal', 'activity_max', 'activityMax']) ?? 0
        const bonusPoints = this.readNumberFromText(combined, ['bonus', 'bonus_points', 'bonusPoints'])

        return {
            streakDays,
            streakProtectionEnabled: protectionRaw,
            bonusText: bonusPoints && bonusPoints > 0 ? `+${bonusPoints} points` : null,
            bonusStarsFilled,
            bonusStarsTotal
        }
    }

    private async readProtectionFromPanel(page: Page): Promise<boolean | null> {
        try {
            if (!page.url().includes('rewards.bing.com')) {
                await page.goto(URLS.dashboard, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
                await this.bot.utils.wait(1000)
            }

            const panel = new RewardsSidePanelController(page)
            const scopes = ['section#snapshot', 'section#streaks', 'main']
            let opened = false

            for (const scope of scopes) {
                const expanded = await panel.expandDisclosure(scope)
                if (expanded) await this.bot.utils.wait(700)

                opened = await panel.openStreakCard(scope)
                if (opened) break
            }

            if (!opened) return null

            await panel.scrollClaimPanelContent()
            await this.bot.utils.wait(400)

            const switchResult = await panel.readFirstSwitchState()
            const checked = switchResult.found ? switchResult.before : null

            await panel.collapseFirstCardByImageToken('Fire', 'section#snapshot').catch(() => undefined)
            await panel.closePanel().catch(() => undefined)
            return checked
        } catch {
            return null
        }
    }

    private needsBrowserFallback(info: DailyStreakInfo): boolean {
        return info.streakDays <= 0 && info.bonusStarsTotal <= 0
    }

    private mergeInfo(base: DailyStreakInfo, extra: Partial<DailyStreakInfo>): DailyStreakInfo {
        return {
            streakDays: extra.streakDays && extra.streakDays > 0 ? extra.streakDays : base.streakDays,
            streakProtectionEnabled:
                extra.streakProtectionEnabled !== undefined && extra.streakProtectionEnabled !== null
                    ? extra.streakProtectionEnabled
                    : base.streakProtectionEnabled,
            bonusText: extra.bonusText ?? base.bonusText,
            bonusStarsFilled: extra.bonusStarsFilled && extra.bonusStarsFilled > 0 ? extra.bonusStarsFilled : base.bonusStarsFilled,
            bonusStarsTotal: extra.bonusStarsTotal && extra.bonusStarsTotal > 0 ? extra.bonusStarsTotal : base.bonusStarsTotal
        }
    }

    private parseProtectionStatus(status?: GiveEligible): boolean | null {
        if (status === GiveEligible.True) return true
        if (status === GiveEligible.False) return false
        return null
    }

    private parseProgress(...values: Array<string | number | undefined>): number {
        for (const value of values) {
            if (value === undefined || value === null || value === '') continue
            const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
            if (!Number.isNaN(parsed)) return Math.max(0, parsed)
        }
        return 0
    }

    private readNumberFromText(text: string, fields: string[]): number | undefined {
        for (const field of fields) {
            const match = text.match(new RegExp(`"${field}"\\s*:\\s*(-?\\d+)`))
            if (match?.[1]) {
                const parsed = Number.parseInt(match[1], 10)
                if (!Number.isNaN(parsed)) return parsed
            }
        }
        return undefined
    }

    private readProtectionFromText(text: string): boolean | null {
        const patterns = [
            /"isProtectionEnabled"\s*:\s*(true|false)/,
            /"isProtectionOn"\s*:\s*(true|false)/
        ]

        for (const pattern of patterns) {
            const match = text.match(pattern)
            if (match?.[1]) return match[1] === 'true'
        }

        return null
    }
}
