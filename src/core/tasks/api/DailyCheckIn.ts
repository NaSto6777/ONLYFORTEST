import { randomUUID } from 'crypto'
import type { Page } from 'patchright'
import type { AxiosRequestConfig } from 'axios'
import { URLS } from '../../../automation/DashboardSelectors'
import { RewardsSidePanelController } from '../../../automation/RewardsSidePanelController'
import { TaskBase } from '../../TaskBase'

const DEFAULT_CHECK_IN_OFFER_ID = 'Gamification_Sapphire_DailyCheckIn'
// Core plugin only retries 101 then 103 (never type 10).
const CHECK_IN_ACTIVITY_TYPES = [101, 103]

interface CheckInPromotion {
    offerId: string
    activityTypes: number[]
    progress: number
    lastUpdated: string
}

export class DailyCheckIn extends TaskBase {
    public async doDailyCheckIn(page?: Page): Promise<void> {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(this.bot.isMobile, 'DAILY-CHECK-IN', 'No mobile access token — skipping')
            return
        }

        const geoLocale = this.normalizeGeoLocale(this.bot.userData.geoLocale)
        const currentPoints = Number(this.bot.userData.currentPoints ?? 0)
        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-CHECK-IN',
            `Starting daily check-in | geo=${geoLocale} | currentPoints=${currentPoints}`
        )

        try {
            const promotion = await this.fetchCheckInPromotion(geoLocale)
            const offerId = promotion?.offerId ?? DEFAULT_CHECK_IN_OFFER_ID
            const activityTypes = this.resolveActivityTypes(promotion?.activityTypes)

            if (promotion) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Resolved promotion | offerId=${offerId} | progress=${promotion.progress} | lastUpdated=${promotion.lastUpdated || 'n/a'} | types=${activityTypes.join(',')}`
                )
            }

            const balanceBefore = await this.fetchAppBalance(geoLocale)
            const { claimedPoints, typesTried } = await this.tryApiCheckIn(
                geoLocale,
                offerId,
                activityTypes,
                balanceBefore
            )

            if (claimedPoints > 0) {
                this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + claimedPoints
                this.bot.userData.gainedPoints = Number(this.bot.userData.gainedPoints ?? 0) + claimedPoints
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Claimed ${claimedPoints} points`,
                    'green'
                )
                return
            }

            if (page && !page.isClosed()) {
                const claimedFromBrowser = await this.tryBrowserCheckIn(page, balanceBefore)
                if (claimedFromBrowser > 0) {
                    this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + claimedFromBrowser
                    this.bot.userData.gainedPoints = Number(this.bot.userData.gainedPoints ?? 0) + claimedFromBrowser
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'DAILY-CHECK-IN',
                        `Claimed ${claimedFromBrowser} points (dashboard)`,
                        'green'
                    )
                    return
                }
            }

            const finalBalance = await this.fetchAppBalance(geoLocale).catch(() => balanceBefore)
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Daily check-in completed but no points gained | typesTried=${typesTried.join(',')} | oldBalance=${balanceBefore} | finalBalance=${finalBalance}`
            )

            if (promotion && this.wasCheckedInToday(promotion.lastUpdated)) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    'Sapphire daily check-in already done today (API). Level-up 0/7 on the website is a separate Bing-app streak.'
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Failed: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private resolveActivityTypes(configuredTypes?: number[]): number[] {
        const allowed = new Set(CHECK_IN_ACTIVITY_TYPES)
        const resolved: number[] = []

        for (const type of configuredTypes ?? []) {
            if (allowed.has(type) && !resolved.includes(type)) {
                resolved.push(type)
            }
        }

        for (const type of CHECK_IN_ACTIVITY_TYPES) {
            if (!resolved.includes(type)) {
                resolved.push(type)
            }
        }

        return resolved
    }

    private async tryApiCheckIn(
        geoLocale: string,
        offerId: string,
        activityTypes: number[],
        balanceBefore: number
    ): Promise<{ claimedPoints: number; typesTried: number[] }> {
        let lastBalance = balanceBefore
        const typesTried: number[] = []

        for (const activityType of activityTypes) {
            typesTried.push(activityType)
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-CHECK-IN', `Attempting daily check-in | type=${activityType}`)

            const requestId = randomUUID()
            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Preparing daily check-in payload | type=${activityType} | id=${requestId} | amount=1 | country=${geoLocale}`
            )

            try {
                const request: AxiosRequestConfig = {
                    url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.bot.accessToken}`,
                        'Content-Type': 'application/json',
                        'X-Rewards-Country': geoLocale,
                        'X-Rewards-Language': 'en',
                        'X-Rewards-ismobile': 'true'
                    },
                    data: JSON.stringify({
                        amount: 1,
                        country: geoLocale,
                        id: requestId,
                        type: activityType,
                        attributes: {
                            offerid: offerId
                        }
                    })
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Sending daily check-in request | type=${activityType} | url=${request.url}`
                )

                const response = await this.bot.axios.request(request)
                const responseData = response.data as {
                    response?: { balance?: number; activity?: { p?: string | number } }
                }

                const balanceAfter = Number(responseData?.response?.balance ?? lastBalance)
                const claimedFromBalance = Math.max(0, balanceAfter - lastBalance)
                const claimedFromActivity =
                    Number.parseInt(String(responseData?.response?.activity?.p ?? '0'), 10) || 0
                const claimedPoints = claimedFromBalance > 0 ? claimedFromBalance : claimedFromActivity

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Received daily check-in response | type=${activityType} | status=${response.status}`
                )
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Balance delta after daily check-in | type=${activityType} | oldBalance=${lastBalance} | newBalance=${balanceAfter} | gainedPoints=${claimedPoints}`
                )

                if (claimedPoints > 0) {
                    return { claimedPoints, typesTried }
                }

                if (activityType === 101 && activityTypes.includes(103)) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'DAILY-CHECK-IN',
                        `No points gained with type=101 | oldBalance=${lastBalance} | newBalance=${balanceAfter} | retryingWithType=103`
                    )
                }

                lastBalance = balanceAfter > 0 ? balanceAfter : lastBalance
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Daily check-in request failed | type=${activityType} | ${message}`
                )
            }
        }

        return { claimedPoints: 0, typesTried }
    }

    private async tryBrowserCheckIn(page: Page, balanceBefore: number): Promise<number> {
        this.bot.logger.info(this.bot.isMobile, 'DAILY-CHECK-IN', 'Trying dashboard check-in fallback')

        if (!page.url().includes('rewards.bing.com')) {
            await page.goto(URLS.dashboard, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
            await this.bot.utils.wait(1500)
        }

        const panel = new RewardsSidePanelController(page)
        const opened = await panel.openBingAppCheckInCard()
        if (!opened) {
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-CHECK-IN', 'Could not open Bing app check-in card on dashboard')
            return 0
        }

        await this.bot.utils.wait(1000)
        await panel.scrollClaimPanelContent()

        const clicked = await panel.clickCheckInCta()
        if (!clicked) {
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-CHECK-IN', 'No check-in button found in dashboard panel')
            await panel.closePanel().catch(() => undefined)
            return 0
        }

        await this.bot.utils.wait(2000)
        const balanceAfter = await this.bot.browser.func.getCurrentPoints()
        const gained = Math.max(0, balanceAfter - balanceBefore)
        await panel.closePanel().catch(() => undefined)
        return gained
    }

    private async fetchCheckInPromotion(geoLocale: string): Promise<CheckInPromotion | null> {
        const request: AxiosRequestConfig = {
            url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
            method: 'GET',
            headers: {
                Authorization: `Bearer ${this.bot.accessToken}`,
                'X-Rewards-Country': geoLocale,
                'X-Rewards-Language': 'en',
                'X-Rewards-ismobile': 'true'
            }
        }

        const response = await this.bot.axios.request(request)
        const responseData = response.data as {
            response?: { promotions?: Array<{ attributes?: Record<string, string> }> }
        }

        for (const item of responseData?.response?.promotions ?? []) {
            const attrs = item.attributes ?? {}
            const offerId = attrs.offerid ?? attrs.offerId ?? ''
            const type = attrs.type ?? ''

            if (type !== 'checkin' && !/sapphire.*dailycheckin|dailycheckin/i.test(offerId)) {
                continue
            }

            const configuredType = Number.parseInt(attrs.activity_type ?? attrs.activitytype ?? '', 10)
            const activityTypes = this.resolveActivityTypes(
                Number.isFinite(configuredType) && configuredType > 0 ? [configuredType] : undefined
            )

            return {
                offerId: offerId || DEFAULT_CHECK_IN_OFFER_ID,
                activityTypes,
                progress: Number.parseInt(attrs.progress ?? '0', 10) || 0,
                lastUpdated: attrs.last_updated ?? ''
            }
        }

        return null
    }

    private wasCheckedInToday(lastUpdated: string): boolean {
        const updated = new Date(lastUpdated)
        const today = new Date()
        if (Number.isNaN(updated.getTime())) {
            return false
        }

        return (
            updated.getFullYear() === today.getFullYear() &&
            updated.getMonth() === today.getMonth() &&
            updated.getDate() === today.getDate()
        )
    }

    private async fetchAppBalance(geoLocale: string): Promise<number> {
        const request: AxiosRequestConfig = {
            url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
            method: 'GET',
            headers: {
                Authorization: `Bearer ${this.bot.accessToken}`,
                'X-Rewards-Country': geoLocale,
                'X-Rewards-Language': 'en',
                'X-Rewards-ismobile': 'true'
            }
        }

        const response = await this.bot.axios.request(request)
        const responseData = response.data as { response?: { balance?: number } }
        return Number(responseData?.response?.balance ?? this.bot.userData.currentPoints ?? 0)
    }

    private normalizeGeoLocale(geoLocale?: string): string {
        const normalized = (geoLocale ?? 'us').trim().toLowerCase()
        return normalized.length === 2 ? normalized : 'us'
    }
}
