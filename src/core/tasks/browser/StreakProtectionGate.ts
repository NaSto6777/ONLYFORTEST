import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import { URLS } from '../../../automation/DashboardSelectors'
import { RewardsSidePanelController, type SwitchSyncResult } from '../../../automation/RewardsSidePanelController'
import { GiveEligible, type DashboardData } from '../../../types/DashboardData'

export type StreakProtectionState = 'enabled' | 'disabled' | 'unknown' | 'unavailable'

export interface StreakProtectionSyncResult {
    desiredEnabled: boolean
    state: StreakProtectionState
    changed: boolean
    reason?: string
}

function parseProtectionStatus(status?: GiveEligible): boolean | null {
    if (status === GiveEligible.True) return true
    if (status === GiveEligible.False) return false
    return null
}

function isProtectionEligible(data: DashboardData): boolean {
    const eligible = data.streakProtectionPromo?.isStreakProtectionOnEligible
    return eligible !== GiveEligible.False
}

export class StreakProtectionGate {
    constructor(private readonly bot: MicrosoftRewardsBot) {}

    async sync(page: Page, desiredEnabled: boolean): Promise<StreakProtectionSyncResult> {
        try {
            const apiState = await this.readProtectionFromApi()
            if (apiState !== null) {
                if (apiState === desiredEnabled) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'STREAK-PROTECTION',
                        `Already ${desiredEnabled ? 'ON' : 'OFF'} via dashboard API; skipping panel toggle`
                    )
                    return {
                        desiredEnabled,
                        state: desiredEnabled ? 'enabled' : 'disabled',
                        changed: false,
                        reason: 'api-already-synced'
                    }
                }

                if (!desiredEnabled) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'STREAK-PROTECTION',
                        'Protection is ON via API but disabling from UI is not supported; leaving enabled'
                    )
                    return { desiredEnabled, state: 'enabled', changed: false, reason: 'disable-not-supported' }
                }
            }

            if (!page.url().includes('rewards.bing.com')) {
                await page.goto(URLS.dashboard, { waitUntil: 'domcontentloaded' })
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

            if (!opened) {
                if (apiState === true && desiredEnabled) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'STREAK-PROTECTION',
                        'Streak panel unavailable but protection is ON via API'
                    )
                    return { desiredEnabled, state: 'enabled', changed: false, reason: 'api-on-panel-unavailable' }
                }

                this.bot.logger.warn(
                    this.bot.isMobile,
                    'STREAK-PROTECTION',
                    'Streak panel unavailable; unable to synchronize protection'
                )
                return { desiredEnabled, state: 'unavailable', changed: false, reason: 'panel-unavailable' }
            }

            await panel.scrollClaimPanelContent()
            await this.bot.utils.wait(400)

            const switchResult = await panel.setFirstSwitchState(desiredEnabled)
            await this.bot.utils.wait(500)

            await panel.collapseFirstCardByImageToken('Fire', 'section#snapshot').catch(() => undefined)
            await panel.closePanel().catch(() => undefined)

            if (!switchResult.found && apiState === true && desiredEnabled) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'STREAK-PROTECTION',
                    'Switch not visible in panel but protection is ON via API'
                )
                return { desiredEnabled, state: 'enabled', changed: false, reason: 'api-on-switch-hidden' }
            }

            return this.toSyncResult(desiredEnabled, switchResult)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.bot.logger.warn(this.bot.isMobile, 'STREAK-PROTECTION', `Sync failed: ${message}`)
            return { desiredEnabled, state: 'unknown', changed: false, reason: message }
        }
    }

    private async readProtectionFromApi(): Promise<boolean | null> {
        try {
            const dashboard = await this.bot.browser.func.getDashboardData()
            if (!isProtectionEligible(dashboard)) {
                return null
            }
            return parseProtectionStatus(dashboard.streakProtectionPromo?.streakProtectionStatus)
        } catch {
            return null
        }
    }

    private toSyncResult(desiredEnabled: boolean, result: SwitchSyncResult): StreakProtectionSyncResult {
        if (!result.found) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'STREAK-PROTECTION',
                'Streak protection switch not found in panel'
            )
            return { desiredEnabled, state: 'unavailable', changed: false, reason: 'switch-not-found' }
        }

        if (result.disabled) {
            this.bot.logger.info(
                this.bot.isMobile,
                'STREAK-PROTECTION',
                `Switch is disabled by Microsoft; current state is ${result.before === null ? 'unknown' : result.before ? 'ON' : 'OFF'}`
            )
            return {
                desiredEnabled,
                state: result.before === null ? 'unknown' : result.before ? 'enabled' : 'disabled',
                changed: false,
                reason: 'switch-disabled'
            }
        }

        const state = result.after === null ? 'unknown' : result.after ? 'enabled' : 'disabled'
        this.bot.logger.info(
            this.bot.isMobile,
            'STREAK-PROTECTION',
            `Desired: ${desiredEnabled ? 'ON' : 'OFF'} | Before: ${
                result.before === null ? 'unknown' : result.before ? 'ON' : 'OFF'
            } | After: ${result.after === null ? 'unknown' : result.after ? 'ON' : 'OFF'}`
        )

        return { desiredEnabled, state, changed: result.changed }
    }
}
