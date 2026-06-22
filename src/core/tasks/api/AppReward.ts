import { randomBytes } from 'crypto'
import type { AxiosRequestConfig } from 'axios'
import type { Promotion } from '../../../types/AppDashboardData'
import { TaskBase } from '../../TaskBase'

const DEDICATED_OFFER_IDS = new Set(['Gamification_Sapphire_DailyCheckIn'])
const READ_TO_EARN_OFFER_PATTERN = /readarticle\d+_\d+points/i

export class AppReward extends TaskBase {
    public async doAppReward(promotion: Promotion): Promise<void> {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(this.bot.isMobile, 'APP-REWARD', 'No mobile access token — skipping')
            return
        }

        const attrs = promotion.attributes ?? {}
        const offerId = attrs.offerid ?? attrs.offerId ?? ''
        const title = attrs.title ?? promotion.name ?? offerId

        if (!offerId) {
            this.bot.logger.warn(this.bot.isMobile, 'APP-REWARD', 'Promotion missing offerid — skipping')
            return
        }

        if (DEDICATED_OFFER_IDS.has(offerId) || READ_TO_EARN_OFFER_PATTERN.test(offerId)) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'APP-REWARD',
                `Skipping ${offerId} — handled by doDailyCheckIn / doReadToEarn`
            )
            return
        }

        const pointMax = Number.parseInt(attrs.pointmax ?? attrs.point_max ?? '1', 10) || 1
        const pointProgress = Number.parseInt(attrs.pointprogress ?? attrs.point_progress ?? '0', 10) || 0
        const remaining = Math.max(0, pointMax - pointProgress)

        if (remaining <= 0) {
            this.bot.logger.info(this.bot.isMobile, 'APP-REWARD', `Already complete | ${title}`)
            return
        }

        const activityType = Number.parseInt(attrs.activity_type ?? attrs.activitytype ?? '101', 10) || 101
        const geoLocale = this.normalizeGeoLocale(this.bot.userData.geoLocale)

        this.bot.logger.info(
            this.bot.isMobile,
            'APP-REWARD',
            `Starting sapphire promotion | title="${title}" | offerId=${offerId} | remaining=${remaining}`
        )

        try {
            let userBalance = await this.fetchAppBalance(geoLocale)
            const maxAttempts = Math.min(remaining, 25)
            let completed = 0

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
                        id: randomBytes(64).toString('hex'),
                        type: activityType,
                        attributes: {
                            offerid: offerId
                        }
                    })
                }

                const response = await this.bot.axios.request(request)
                const responseData = response.data as {
                    response?: { balance?: number; activity?: { p?: string | number } }
                }

                const newBalance = Number(responseData?.response?.balance ?? userBalance)
                const gainedFromBalance = Math.max(0, newBalance - userBalance)
                const gainedFromActivity = Number.parseInt(String(responseData?.response?.activity?.p ?? '0'), 10) || 0
                const gainedPoints = gainedFromBalance > 0 ? gainedFromBalance : gainedFromActivity

                if (gainedPoints <= 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'APP-REWARD',
                        `No more points from promotion | title="${title}" | offerId=${offerId}`
                    )
                    break
                }

                userBalance = newBalance > 0 ? newBalance : userBalance + gainedPoints
                completed += 1
                this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                this.bot.userData.gainedPoints = Number(this.bot.userData.gainedPoints ?? 0) + gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'APP-REWARD',
                    `+${gainedPoints} points | title="${title}" | progress=${completed}/${remaining}`,
                    'green'
                )

                if (completed >= remaining) {
                    break
                }

                await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 8000))
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'APP-REWARD',
                `Finished sapphire promotion | title="${title}" | steps=${completed}`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'APP-REWARD',
                `Failed | title="${title}" | offerId=${offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
        }
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
