import { randomBytes } from 'crypto'
import type { AxiosRequestConfig } from 'axios'
import { TaskBase } from '../../TaskBase'

const READ_TO_EARN_OFFER_ID = 'ENUS_readarticle3_30points'
const MAX_ARTICLES = 10

export class ReadToEarn extends TaskBase {
    public async doReadToEarn(): Promise<void> {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(this.bot.isMobile, 'READ-TO-EARN', 'No mobile access token — skipping')
            return
        }

        this.bot.logger.info(this.bot.isMobile, 'READ-TO-EARN', 'Starting Read to Earn')

        try {
            const earnable = await this.bot.browser.func.getAppEarnablePoints()
            if (earnable.readToEarn <= 0) {
                this.bot.logger.info(this.bot.isMobile, 'READ-TO-EARN', 'All articles already read today')
                return
            }

            const geoLocale = this.normalizeGeoLocale(this.bot.userData.geoLocale)
            let userBalance = await this.fetchAppBalance(geoLocale)

            for (let i = 0; i < MAX_ARTICLES; i++) {
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
                        type: 101,
                        attributes: {
                            offerid: READ_TO_EARN_OFFER_ID
                        }
                    })
                }

                const response = await this.bot.axios.request(request)
                const responseData = response.data as { response?: { balance?: number; activity?: { p?: string | number } } }
                const newBalance = Number(responseData?.response?.balance ?? userBalance)
                const gainedPoints = Math.max(0, newBalance - userBalance)

                if (gainedPoints === 0) {
                    this.bot.logger.info(this.bot.isMobile, 'READ-TO-EARN', 'Read all available articles')
                    break
                }

                userBalance = newBalance
                this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                this.bot.userData.gainedPoints = Number(this.bot.userData.gainedPoints ?? 0) + gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Read article ${i + 1}/${MAX_ARTICLES} | +${gainedPoints} points`,
                    'green'
                )

                await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 8000))
            }

            this.bot.logger.info(this.bot.isMobile, 'READ-TO-EARN', 'Completed Read to Earn')
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Failed: ${error instanceof Error ? error.message : String(error)}`
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
