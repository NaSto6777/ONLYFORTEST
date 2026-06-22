import type { Page } from 'patchright'
import { URLS } from '../../../automation/DashboardSelectors'
import { RewardsSidePanelController } from '../../../automation/RewardsSidePanelController'
import type { ClaimEntry, ClaimPointsResult } from '../../InternalPluginAPI'
import { TaskBase } from '../../TaskBase'
import { DashboardInfoCollector } from './DashboardInfo'

const CLAIM_IMAGE_TOKENS = [
    'Giftbox',
    'Coins',
    'Claim',
    'PointClaim',
    'pointsclaim',
    'MonthlyBonus',
    'Star',
    'Coin'
]

export class ClaimPoints extends TaskBase {
    public async doClaimPoints(page: Page): Promise<ClaimPointsResult> {
        this.bot.logger.info(this.bot.isMobile, 'CLAIM-POINTS', 'Checking ready-to-claim cards')

        const emptyResult = (entries: ClaimEntry[] = []): ClaimPointsResult => ({
            claimed: false,
            pointsClaimed: 0,
            entries
        })

        try {
            await this.prepareDashboard(page)

            const dashboardInfo = new DashboardInfoCollector(this.bot)
            const claimData = await dashboardInfo.getReadyToClaim(page)

            if (claimData.readyToClaimPoints <= 0 && claimData.claimEntries.length === 0) {
                this.bot.logger.info(this.bot.isMobile, 'CLAIM-POINTS', 'No points ready to claim')
                return emptyResult()
            }

            const categories = claimData.claimEntries.map(entry => entry.category).filter(Boolean)
            const oldBalance = await this.bot.browser.func.getCurrentPoints()

            const uiAttempted = await this.claimViaDashboardUi(page)
            let verification = await this.verifyClaimResult(page, oldBalance, claimData)

            if (!verification.verified) {
                const apiAttempted = await this.bot.browser.func.claimPointsViaBrowser(page, categories)
                if (apiAttempted || !uiAttempted) {
                    verification = await this.verifyClaimResult(page, oldBalance, claimData)
                }
            }

            if (verification.verified && verification.pointsClaimed > 0) {
                const newBalance = oldBalance + verification.pointsClaimed
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints =
                    Number(this.bot.userData.gainedPoints ?? 0) + verification.pointsClaimed
                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-POINTS',
                    `Claimed ${verification.pointsClaimed} points | Entries: ${claimData.claimEntries.length}`,
                    'green'
                )

                return {
                    claimed: true,
                    pointsClaimed: verification.pointsClaimed,
                    entries: claimData.claimEntries
                }
            }

            if (uiAttempted) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-POINTS',
                    `Claim UI was clicked but balance did not increase (still ${oldBalance}) — claim may have failed`
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-POINTS',
                    `Found ${claimData.readyToClaimPoints} ready-to-claim points, but claim UI/API was unavailable`
                )
            }

            return emptyResult(claimData.claimEntries)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'CLAIM-POINTS',
                `Failed: ${error instanceof Error ? error.message : String(error)}`
            )
            return emptyResult()
        }
    }

    private async verifyClaimResult(
        page: Page,
        oldBalance: number,
        beforeClaim: { readyToClaimPoints: number; claimEntries: ClaimEntry[] }
    ): Promise<{ verified: boolean; pointsClaimed: number }> {
        const dashboardInfo = new DashboardInfoCollector(this.bot)

        for (const waitMs of [2000, 3000, 5000]) {
            await this.bot.utils.wait(waitMs)

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            const pointsFromBalance = Math.max(0, newBalance - oldBalance)
            if (pointsFromBalance > 0) {
                return { verified: true, pointsClaimed: pointsFromBalance }
            }

            const afterClaim = await dashboardInfo.getReadyToClaim(page)
            if (
                beforeClaim.readyToClaimPoints > 0 &&
                afterClaim.readyToClaimPoints < beforeClaim.readyToClaimPoints
            ) {
                const pointsFromCard =
                    beforeClaim.readyToClaimPoints - afterClaim.readyToClaimPoints || beforeClaim.readyToClaimPoints
                return { verified: true, pointsClaimed: pointsFromCard }
            }

            if (beforeClaim.claimEntries.length > 0 && afterClaim.claimEntries.length === 0) {
                return { verified: true, pointsClaimed: beforeClaim.readyToClaimPoints }
            }
        }

        return { verified: false, pointsClaimed: 0 }
    }

    private async prepareDashboard(page: Page): Promise<void> {
        if (!page.url().includes('rewards.bing.com')) {
            await page.goto(URLS.dashboard, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
        }

        await this.bot.browser.utils.tryDismissAllMessages(page)
        await page.goto(URLS.dashboard, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {})
        await page.waitForSelector('section#snapshot, section#dailyset, main', { timeout: 15_000 }).catch(() => {})
        await this.bot.utils.wait(1000)
    }

    private async claimViaDashboardUi(page: Page): Promise<boolean> {
        const originalViewport = page.viewportSize()
        // Claim modals can be ~1000px tall; use a tall desktop viewport so the CTA stays reachable.
        const viewports = [
            { width: 1280, height: 1400 },
            { width: 1280, height: 1200 },
            { width: 1280, height: 900 },
            originalViewport && originalViewport.height >= 1100 ? originalViewport : null
        ].filter((value, index, array): value is { width: number; height: number } => {
            if (!value) return false
            return array.findIndex(item => item?.width === value.width && item?.height === value.height) === index
        })

        for (const viewport of viewports) {
            await page.setViewportSize(viewport).catch(() => {})
            await page.goto(URLS.dashboard, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
            await this.bot.utils.wait(800)

            const panel = new RewardsSidePanelController(page)
            for (const scope of ['section#snapshot', 'main', 'body']) {
                const expanded = await panel.expandDisclosure(scope)
                if (expanded) await this.bot.utils.wait(700)

                let opened = false
                for (const token of CLAIM_IMAGE_TOKENS) {
                    opened = await panel.openFirstCardByImageToken(token, scope)
                    if (opened) break
                }

                if (!opened) {
                    opened = await panel.openClaimCard(scope)
                }

                if (!opened) continue

                await this.bot.utils.wait(700)
                await panel.scrollClaimPanelContent()
                const clicked = await panel.clickClaimCta()
                if (clicked) {
                    await panel.closePanel()
                    if (originalViewport) {
                        await page.setViewportSize(originalViewport).catch(() => {})
                    }
                    return true
                }

                await panel.closePanel()
            }
        }

        if (originalViewport) {
            await page.setViewportSize(originalViewport).catch(() => {})
        }

        return false
    }
}
