import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import { getCurrentContext } from '../../../context/ExecutionContext'

export class PasswordlessStrategy {
    private readonly numberDisplaySelector = 'div[data-testid="displaySign"]'
    private readonly approvalPath = '/ppsecure/post.srf'

    constructor(private bot: MicrosoftRewardsBot) {}

    private get maxAttempts(): number {
        const configured = this.bot.config.auth?.passwordlessTimeoutSeconds
        return typeof configured === 'number' && configured > 0 ? configured : 180
    }

    private async getDisplayedNumber(page: Page): Promise<string | null> {
        try {
            const numberElement = await page
                .waitForSelector(this.numberDisplaySelector, {
                    timeout: 5000
                })
                .catch(() => null)

            if (numberElement) {
                const number = await numberElement.textContent()
                return number?.trim() || null
            }
        } catch (error) {
            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-PASSWORDLESS', 'Could not retrieve displayed number')
        }
        return null
    }

    private publishPrompt(displayedNumber: string | null): void {
        const account = getCurrentContext().account
        this.bot.showPasswordlessPrompt({
            email: account?.email || 'unknown',
            number: displayedNumber,
            platform: this.bot.isMobile ? 'mobile' : 'desktop',
            timeoutSeconds: this.maxAttempts
        })
    }

    private async waitForApproval(page: Page): Promise<boolean> {
        try {
            this.bot.logger.info(
                this.bot.isMobile,
                'LOGIN-PASSWORDLESS',
                `Waiting for approval... (timeout after ${this.maxAttempts} seconds)`
            )

            for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
                const currentUrl = new URL(page.url())
                if (currentUrl.pathname === this.approvalPath) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-PASSWORDLESS', 'Approval detected')
                    return true
                }

                if (attempt % 5 === 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN-PASSWORDLESS',
                        `Still waiting... (${attempt}/${this.maxAttempts} seconds elapsed)`
                    )
                }

                await this.bot.utils.wait(1000)
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-PASSWORDLESS',
                `Approval timeout after ${this.maxAttempts} seconds!`
            )
            return false
        } catch (error: any) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-PASSWORDLESS',
                `Approval failed, an error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async handle(page: Page): Promise<void> {
        let promptPublished = false

        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-PASSWORDLESS', 'Passwordless authentication requested')

            const displayedNumber = await this.getDisplayedNumber(page)
            this.publishPrompt(displayedNumber)
            promptPublished = true

            if (displayedNumber) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-PASSWORDLESS',
                    `Please approve login and select number: ${displayedNumber}`,
                    'yellowBright'
                )
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-PASSWORDLESS',
                    'Please approve login on your authenticator app',
                    'yellowBright'
                )
            }

            const approved = await this.waitForApproval(page)

            if (approved) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-PASSWORDLESS', 'Login approved successfully')
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
            } else {
                this.bot.logger.error(this.bot.isMobile, 'LOGIN-PASSWORDLESS', 'Login approval failed or timed out')
                throw new Error('Passwordless authentication timeout')
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-PASSWORDLESS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        } finally {
            if (promptPublished) {
                this.bot.clearPasswordlessPrompt()
            }
        }
    }
}
