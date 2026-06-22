import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'

// Core task imports (always available in the public edition)
import { AppReward } from './tasks/api/AppReward'
import { DailyCheckIn } from './tasks/api/DailyCheckIn'
import { ReadToEarn } from './tasks/api/ReadToEarn'
import { FindClippy } from './tasks/api/FindClippy'
import { Quiz } from './tasks/api/Quiz'
import { UrlReward } from './tasks/api/UrlReward'
import { ClaimPoints } from './tasks/browser/ClaimPoints'
import { DashboardInfoCollector } from './tasks/browser/DashboardInfo'
import { DailyStreak } from './tasks/browser/DailyStreak'
import { Search } from './tasks/browser/Search'
import { SearchOnBing } from './tasks/browser/SearchOnBing'
import { StreakProtectionGate } from './tasks/browser/StreakProtectionGate'

// Types
import type { Promotion } from '../types/AppDashboardData'
import type { ConfigRedeemGoal } from '../types/Config'
import type { BasePromotion, DashboardData, FindClippyPromotion, PurplePromotionalItem } from '../types/DashboardData'
import type {
    ClaimPointsResult,
    DailyStreakInfo,
    DashboardInfo,
    PremiumTaskMap,
    TemporaryPunchcardsResult
} from './InternalPluginAPI'
import type { StreakProtectionSyncResult } from './tasks/browser/StreakProtectionGate'

export default class ActivityRunner {
    private bot: MicrosoftRewardsBot
    private premiumTasks: Partial<PremiumTaskMap> = {}
    private premiumHintsShown = new Set<string>()

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Install premium task implementations provided by a plugin.
     * Called by PluginManager after plugins have registered their tasks.
     */
    installPremiumTasks(tasks: Partial<PremiumTaskMap>): void {
        this.premiumTasks = { ...this.premiumTasks, ...tasks }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CORE TASKS (always available)
    // ═══════════════════════════════════════════════════════════════════════

    doSearch = async (data: DashboardData, page: Page, isMobile: boolean): Promise<number> => {
        const search = new Search(this.bot)
        return await search.doSearch(data, page, isMobile)
    }

    doSearchOnBing = async (promotion: BasePromotion, page: Page): Promise<void> => {
        const searchOnBing = new SearchOnBing(this.bot)
        await searchOnBing.doSearchOnBing(promotion, page)
    }

    doUrlReward = async (promotion: BasePromotion): Promise<void> => {
        const urlReward = new UrlReward(this.bot)
        await urlReward.doUrlReward(promotion)
    }

    doQuiz = async (promotion: BasePromotion): Promise<void> => {
        const quiz = new Quiz(this.bot)
        await quiz.doQuiz(promotion)
    }

    doFindClippy = async (promotion: FindClippyPromotion): Promise<void> => {
        const findClippy = new FindClippy(this.bot)
        await findClippy.doFindClippy(promotion)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PREMIUM TASKS (no-op stubs — replaced by plugin if installed)
    // ═══════════════════════════════════════════════════════════════════════

    doDoubleSearchPoints = async (promotion: PurplePromotionalItem): Promise<void> => {
        if (this.premiumTasks.doDoubleSearchPoints) {
            return this.premiumTasks.doDoubleSearchPoints(promotion)
        }
        this.coreHint('Double Search Points', 'Core can activate eligible double-search promotions when Microsoft offers them.')
    }

    doAppReward = async (promotion: Promotion): Promise<void> => {
        if (this.premiumTasks.doAppReward) {
            return this.premiumTasks.doAppReward(promotion)
        }

        const appReward = new AppReward(this.bot)
        await appReward.doAppReward(promotion)
    }

    doReadToEarn = async (): Promise<void> => {
        if (this.premiumTasks.doReadToEarn) {
            return this.premiumTasks.doReadToEarn()
        }

        const readToEarn = new ReadToEarn(this.bot)
        await readToEarn.doReadToEarn()
    }

    doDailyCheckIn = async (page?: Page): Promise<void> => {
        if (this.premiumTasks.doDailyCheckIn) {
            return this.premiumTasks.doDailyCheckIn()
        }

        const dailyCheckIn = new DailyCheckIn(this.bot)
        await dailyCheckIn.doDailyCheckIn(page)
    }

    doDailyStreak = async (page: Page): Promise<DailyStreakInfo | null> => {
        if (this.premiumTasks.doDailyStreak) {
            return this.premiumTasks.doDailyStreak(page)
        }

        const dailyStreak = new DailyStreak(this.bot)
        return dailyStreak.doDailyStreak(page)
    }

    doRedeemGoal = async (page: Page, config: ConfigRedeemGoal): Promise<void> => {
        if (this.premiumTasks.doRedeemGoal) {
            return this.premiumTasks.doRedeemGoal(page, config)
        }
        this.coreHint('Redeem Goal', 'Core can manage supported redeem-goal dashboard actions.')
    }

    collectDashboardInfo = async (page: Page): Promise<DashboardInfo> => {
        if (this.premiumTasks.collectDashboardInfo) {
            return this.premiumTasks.collectDashboardInfo(page)
        }

        const dashboardInfo = new DashboardInfoCollector(this.bot)
        return dashboardInfo.collectDashboardInfo(page)
    }

    refreshDashboardSnapshot = async (
        prior: DashboardInfo | null,
        streakDaysOverride?: number | null
    ): Promise<DashboardInfo> => {
        const dashboardInfo = new DashboardInfoCollector(this.bot)
        return dashboardInfo.refreshDashboardSnapshot(prior, streakDaysOverride)
    }

    doClaimPoints = async (page: Page): Promise<ClaimPointsResult> => {
        if (this.premiumTasks.doClaimPoints) {
            return this.premiumTasks.doClaimPoints(page)
        }

        const claimPoints = new ClaimPoints(this.bot)
        return claimPoints.doClaimPoints(page)
    }

    doTemporaryPunchcards = async (page: Page): Promise<TemporaryPunchcardsResult> => {
        if (this.premiumTasks.doTemporaryPunchcards) {
            return this.premiumTasks.doTemporaryPunchcards(page)
        }
        this.coreHint('Temporary Punchcards', 'Core can attempt supported temporary dashboard punchcards when they appear.')
        return { visited: 0, completedSteps: 0, skippedSteps: 0 }
    }

    syncStreakProtection = async (page: Page, desiredEnabled: boolean): Promise<StreakProtectionSyncResult> => {
        const gate = new StreakProtectionGate(this.bot)
        return gate.sync(page, desiredEnabled)
    }

    private coreHint(feature: string, detail: string): void {
        if (this.premiumHintsShown.has(feature)) {
            this.bot.logger.warn('main', 'CORE-OPTIONAL', `${feature} requires Core — skipping.`)
            return
        }

        this.premiumHintsShown.add(feature)
        this.bot.logger.warn(
            'main',
            'CORE-OPTIONAL',
            `${feature} requires Core — skipping. ${detail} Learn more: https://github.com/QuestPilot/Microsoft-Rewards-Bot/blob/HEAD/docs/core-plugin.md`
        )
    }
}
