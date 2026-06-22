import type { Page } from 'patchright'
import { URLS } from './DashboardSelectors'

export interface SidePanelSnapshot {
    panelCount: number
    switchCount: number
    expandedDisclosureCount: number
    progressBarCount: number
    buttonCount: number
}

export interface SwitchSyncResult {
    found: boolean
    disabled: boolean
    before: boolean | null
    after: boolean | null
    changed: boolean
}

export class RewardsSidePanelController {
    constructor(private readonly page: Page) {}

    async snapshot(): Promise<SidePanelSnapshot> {
        return this.page.evaluate(() => {
            const panels = Array.from(
                document.querySelectorAll('[role="dialog"], .react-aria-DisclosurePanel:not([hidden])')
            ).filter(el => {
                const rect = el.getBoundingClientRect()
                const style = window.getComputedStyle(el)
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            })

            return {
                panelCount: panels.length,
                switchCount: document.querySelectorAll('input[role="switch"]').length,
                expandedDisclosureCount: document.querySelectorAll('button[aria-expanded="true"]').length,
                progressBarCount: document.querySelectorAll('[role="progressbar"]').length,
                buttonCount: panels.reduce((count, panel) => count + panel.querySelectorAll('button').length, 0)
            }
        })
    }

    async waitForPanel(timeoutMs = 5000): Promise<boolean> {
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
            const snapshot = await this.snapshot().catch(() => null)
            if (snapshot && snapshot.panelCount > 0) return true
            await this.page.waitForTimeout(250).catch(() => undefined)
        }

        return false
    }

    async openFirstCardByImageToken(token: string, scope = 'body'): Promise<boolean> {
        const clicked = await this.page.evaluate(
            ({ token, scope }) => {
                const root = document.querySelector(scope) ?? document.body
                const images = Array.from(root.querySelectorAll('img[src], img[srcset]'))
                const image = images.find(img => {
                    const src = img.getAttribute('src') ?? ''
                    const srcset = img.getAttribute('srcset') ?? ''
                    return src.includes(token) || srcset.includes(token)
                })
                const trigger = image?.closest('button[aria-expanded], button[data-rac], a[data-rac]') as
                    | HTMLElement
                    | null
                if (!trigger) return false
                trigger.scrollIntoView({ block: 'center', inline: 'nearest' })
                trigger.click()
                return true
            },
            { token, scope }
        )

        return clicked ? this.waitForPanel(8000) : false
    }

    async openStreakCard(scope = 'section#snapshot'): Promise<boolean> {
        const scopes = uniqueScopes(scope)
        const imageTokens = ['Fire', 'fire', 'Streak', 'streak', 'flame']

        for (const scopeSelector of scopes) {
            for (const token of imageTokens) {
                if (await this.openFirstCardByImageToken(token, scopeSelector)) {
                    return true
                }
            }

            const clicked = await this.page.evaluate(scopeSelector => {
                const root = document.querySelector(scopeSelector) ?? document.body
                const keywords = [
                    'streak protection',
                    'daily streak',
                    'streak counter',
                    'série',
                    'protection de série',
                    'racha',
                    'day streak'
                ]

                const triggers = Array.from(
                    root.querySelectorAll<HTMLElement>(
                        'button[aria-expanded], button[data-rac], a[data-rac], button, [role="button"]'
                    )
                )

                for (const trigger of triggers) {
                    const text = (trigger.textContent ?? '').toLowerCase()
                    const alt = (trigger.querySelector('img')?.getAttribute('alt') ?? '').toLowerCase()
                    const aria = (trigger.getAttribute('aria-label') ?? '').toLowerCase()
                    const combined = `${text} ${alt} ${aria}`
                    if (keywords.some(keyword => combined.includes(keyword))) {
                        trigger.scrollIntoView({ block: 'center', inline: 'nearest' })
                        trigger.click()
                        return true
                    }
                }

                return false
            }, scopeSelector)

            if (clicked && (await this.waitForPanel(8000))) {
                return true
            }
        }

        return false
    }

    async expandDisclosure(scope: string): Promise<boolean> {
        return this.page.evaluate(scope => {
            const root = document.querySelector(scope)
            const trigger = root?.querySelector<HTMLElement>('button[slot="trigger"][aria-expanded="false"]')
            if (!trigger) return false
            trigger.click()
            return true
        }, scope)
    }

    async collapseFirstCardByImageToken(token: string, scope = 'body'): Promise<boolean> {
        return this.page.evaluate(
            ({ token, scope }) => {
                const root = document.querySelector(scope) ?? document.body
                const images = Array.from(root.querySelectorAll('img[src], img[srcset]'))
                const image = images.find(img => {
                    const src = img.getAttribute('src') ?? ''
                    const srcset = img.getAttribute('srcset') ?? ''
                    return src.includes(token) || srcset.includes(token)
                })
                const trigger = image?.closest('button[aria-expanded="true"]') as HTMLElement | null
                if (!trigger) return false
                trigger.click()
                return true
            },
            { token, scope }
        )
    }

    async readFirstSwitchState(): Promise<SwitchSyncResult> {
        for (let attempt = 0; attempt < 4; attempt++) {
            const result = await this.page.evaluate(() => {
                const isVisibleElement = (el: Element): boolean => {
                    const rect = el.getBoundingClientRect()
                    const style = window.getComputedStyle(el)
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
                }

                const roots: ParentNode[] = [
                    ...Array.from(document.querySelectorAll('[role="dialog"]')),
                    ...Array.from(document.querySelectorAll('.react-aria-DisclosurePanel:not([hidden])')),
                    document.body
                ]

                const readChecked = (el: HTMLElement): boolean | null => {
                    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
                        return el.checked
                    }
                    if (el instanceof HTMLInputElement && el.getAttribute('role') === 'switch') {
                        return el.checked
                    }
                    const aria = el.getAttribute('aria-checked')
                    if (aria === 'true') return true
                    if (aria === 'false') return false
                    return null
                }

                const isDisabled = (el: HTMLElement): boolean => {
                    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
                        return true
                    }
                    return el.closest('[data-disabled="true"]') !== null
                }

                const candidates: HTMLElement[] = []
                for (const root of roots) {
                    candidates.push(
                        ...Array.from(root.querySelectorAll<HTMLElement>('input[role="switch"]')),
                        ...Array.from(root.querySelectorAll<HTMLElement>('[role="switch"]'))
                    )

                    const labels = Array.from(root.querySelectorAll<HTMLElement>('label'))
                    for (const label of labels) {
                        const text = (label.textContent ?? '').toLowerCase()
                        if (
                            text.includes('streak protection') ||
                            text.includes('protection de série') ||
                            text.includes('protección de racha')
                        ) {
                            const nested =
                                label.querySelector<HTMLElement>('[role="switch"], input[role="switch"]') ??
                                (label as HTMLLabelElement).control
                            if (nested instanceof HTMLElement) {
                                candidates.push(nested)
                            } else {
                                candidates.push(label)
                            }
                        }
                    }
                }

                const unique = [...new Set(candidates)]
                const target = unique.find(el => {
                    const label = el.closest('label')
                    return isVisibleElement(el) || (label instanceof Element && isVisibleElement(label))
                })

                if (!target) {
                    return { found: false, disabled: false, before: null, after: null, changed: false }
                }

                const before = readChecked(target)
                return {
                    found: true,
                    disabled: isDisabled(target),
                    before,
                    after: before,
                    changed: false
                }
            })

            if (result.found) {
                return result
            }

            await this.page.waitForTimeout(400).catch(() => undefined)
        }

        return { found: false, disabled: false, before: null, after: null, changed: false }
    }

    async setFirstSwitchState(targetChecked: boolean): Promise<SwitchSyncResult> {
        for (let attempt = 0; attempt < 4; attempt++) {
            const result = await this.page.evaluate(targetChecked => {
                const isVisibleElement = (el: Element): boolean => {
                    const rect = el.getBoundingClientRect()
                    const style = window.getComputedStyle(el)
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
                }

                const roots: ParentNode[] = [
                    ...Array.from(document.querySelectorAll('[role="dialog"]')),
                    ...Array.from(document.querySelectorAll('.react-aria-DisclosurePanel:not([hidden])')),
                    document.body
                ]

                const readChecked = (el: HTMLElement): boolean | null => {
                    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
                        return el.checked
                    }
                    if (el instanceof HTMLInputElement && el.getAttribute('role') === 'switch') {
                        return el.checked
                    }
                    const aria = el.getAttribute('aria-checked')
                    if (aria === 'true') return true
                    if (aria === 'false') return false
                    return null
                }

                const isDisabled = (el: HTMLElement): boolean => {
                    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
                        return true
                    }
                    return el.closest('[data-disabled="true"]') !== null
                }

                const candidates: HTMLElement[] = []
                for (const root of roots) {
                    candidates.push(
                        ...Array.from(root.querySelectorAll<HTMLElement>('input[role="switch"]')),
                        ...Array.from(root.querySelectorAll<HTMLElement>('[role="switch"]'))
                    )

                    const labels = Array.from(root.querySelectorAll<HTMLElement>('label'))
                    for (const label of labels) {
                        const text = (label.textContent ?? '').toLowerCase()
                        if (
                            text.includes('streak protection') ||
                            text.includes('protection de série') ||
                            text.includes('protección de racha')
                        ) {
                            const nested =
                                label.querySelector<HTMLElement>('[role="switch"], input[role="switch"]') ??
                                (label as HTMLLabelElement).control
                            if (nested instanceof HTMLElement) {
                                candidates.push(nested)
                            } else {
                                candidates.push(label)
                            }
                        }
                    }
                }

                const unique = [...new Set(candidates)]
                const target = unique.find(el => {
                    const label = el.closest('label')
                    return isVisibleElement(el) || (label instanceof Element && isVisibleElement(label))
                })

                if (!target) {
                    return { found: false, disabled: false, before: null, after: null, changed: false }
                }

                const before = readChecked(target)
                const disabled = isDisabled(target)
                if (disabled || before === targetChecked) {
                    return { found: true, disabled, before, after: before, changed: false }
                }

                const clickable =
                    (target.closest('label') as HTMLElement | null) ??
                    target.querySelector<HTMLElement>('[role="switch"]') ??
                    target
                clickable.click()

                const after = readChecked(target)
                return {
                    found: true,
                    disabled: false,
                    before,
                    after,
                    changed: after !== null && before !== null ? after !== before : true
                }
            }, targetChecked)

            if (result.found) {
                return result
            }

            await this.page.waitForTimeout(400).catch(() => undefined)
        }

        return { found: false, disabled: false, before: null, after: null, changed: false }
    }

    async openClaimCard(scope = 'section#snapshot'): Promise<boolean> {
        const scopes = uniqueScopes(scope)
        for (const scopeSelector of scopes) {
            const clicked = await this.page.evaluate(scopeSelector => {
                const root = document.querySelector(scopeSelector) ?? document.body
                const keywords = [
                    'claim',
                    'réclamer',
                    'reclamar',
                    'ready to claim',
                    'prêt à réclamer',
                    'claim points',
                    'redeem points',
                    'points to claim',
                    'prêt à récupérer'
                ]

                const triggers = Array.from(
                    root.querySelectorAll<HTMLElement>('button[aria-expanded], button[data-rac], a[data-rac], button')
                )

                for (const trigger of triggers) {
                    const text = (trigger.textContent ?? '').toLowerCase()
                    const alt = (trigger.querySelector('img')?.getAttribute('alt') ?? '').toLowerCase()
                    const title = (trigger.querySelector('p.text-body1Strong, p.text-body1Stronger')?.textContent ?? '').toLowerCase()
                    if (keywords.some(keyword => text.includes(keyword) || alt.includes(keyword) || title.includes(keyword))) {
                        trigger.scrollIntoView({ block: 'center', inline: 'nearest' })
                        trigger.click()
                        return true
                    }
                }

                return false
            }, scopeSelector)

            if (clicked && (await this.waitForPanel())) {
                return true
            }
        }

        return false
    }

    async scrollClaimPanelContent(): Promise<void> {
        await this.page.evaluate(() => {
            const isScrollable = (el: Element): boolean => {
                if (!(el instanceof HTMLElement)) return false
                const style = window.getComputedStyle(el)
                const overflowY = style.overflowY
                return (
                    (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
                    el.scrollHeight > el.clientHeight + 8
                )
            }

            const roots = [
                ...Array.from(document.querySelectorAll('[role="dialog"]')),
                ...Array.from(document.querySelectorAll('.react-aria-DisclosurePanel:not([hidden])'))
            ]

            for (const root of roots) {
                const scrollables = new Set<HTMLElement>()
                if (root instanceof HTMLElement && isScrollable(root)) {
                    scrollables.add(root)
                }

                root.querySelectorAll('*').forEach(node => {
                    if (node instanceof HTMLElement && isScrollable(node)) {
                        scrollables.add(node)
                    }
                })

                for (const el of scrollables) {
                    el.scrollTop = el.scrollHeight
                }
            }
        })

        const dialog = this.page.locator('[role="dialog"]').first()
        if ((await dialog.count()) > 0) {
            const box = await dialog.boundingBox().catch(() => null)
            if (box) {
                await this.page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height - 20, box.height / 2))
                for (let step = 0; step < 6; step++) {
                    await this.page.mouse.wheel(0, 500)
                    await this.page.waitForTimeout(120).catch(() => undefined)
                }
            }
        }
    }

    async clickClaimCta(): Promise<boolean> {
        await this.scrollClaimPanelContent()

        const claimPattern = /claim|réclamer|redeem|reclamar/i
        const skipPattern = /nothing|aucun|no point|error|progress|learn more|view|close|fermer|cancel/i

        const buttonScopes = ['[role="dialog"] button', '[role="dialog"] [role="button"]', 'button']
        for (const scope of buttonScopes) {
            const buttons = this.page.locator(scope)
            const count = await buttons.count()
            for (let index = count - 1; index >= 0; index--) {
                const button = buttons.nth(index)
                const text = ((await button.textContent().catch(() => '')) ?? '').toLowerCase().trim()
                if (!text || skipPattern.test(text) || !claimPattern.test(text)) {
                    continue
                }

                try {
                    await button.scrollIntoViewIfNeeded({ timeout: 5000 })
                    await button.click({ timeout: 5000 })
                    await this.page.waitForTimeout(800).catch(() => undefined)
                    return true
                } catch {
                    try {
                        await button.click({ timeout: 5000, force: true })
                        await this.page.waitForTimeout(800).catch(() => undefined)
                        return true
                    } catch {
                        continue
                    }
                }
            }
        }

        const clicked = await this.page.evaluate(() => {
            const keywords = ['claim', 'réclamer', 'redeem', 'reclamar']
            const skipKeywords = ['nothing', 'aucun', 'no point', 'error', 'progress', 'learn more', 'view', 'close']

            const roots = [
                ...Array.from(document.querySelectorAll('[role="dialog"]')),
                document.body
            ]

            for (const root of roots) {
                const candidates = [
                    ...Array.from(root.querySelectorAll<HTMLElement>('button')),
                    ...Array.from(
                        root.querySelectorAll<HTMLElement>(
                            'div.bg-rewardsBgAlpha1, div[class*="rewardsBgAlpha"], div[class*="font-semibold"]'
                        )
                    )
                ]

                for (const candidate of candidates.reverse()) {
                    const text = (candidate.textContent ?? '').toLowerCase().trim()
                    if (!text || skipKeywords.some(keyword => text.includes(keyword))) continue
                    if (!keywords.some(keyword => text.includes(keyword))) continue

                    candidate.scrollIntoView({ block: 'end', inline: 'nearest' })
                    candidate.click()
                    return true
                }
            }

            return false
        })

        if (clicked) {
            await this.page.waitForTimeout(800).catch(() => undefined)
        }

        return clicked
    }

    async openBingAppCheckInCard(scope = 'section#streaks'): Promise<boolean> {
        const scopes = uniqueScopes(scope)
        for (const scopeSelector of scopes) {
            const clicked = await this.page.evaluate(scopeSelector => {
                const root = document.querySelector(scopeSelector) ?? document.body
                const keywords = [
                    'check in on bing app',
                    'check in to the bing app',
                    'bing app',
                    'mobile app',
                    'application mobile',
                    'sapphire',
                    'open bing'
                ]

                const triggers = Array.from(
                    root.querySelectorAll<HTMLElement>(
                        'button[aria-expanded], button[data-rac], a[data-rac], button, a[href*="modal="]'
                    )
                )

                for (const trigger of triggers) {
                    const text = (trigger.textContent ?? '').toLowerCase()
                    const alt = (trigger.querySelector('img')?.getAttribute('alt') ?? '').toLowerCase()
                    const aria = (trigger.getAttribute('aria-label') ?? '').toLowerCase()
                    const combined = `${text} ${alt} ${aria}`
                    if (keywords.some(keyword => combined.includes(keyword))) {
                        trigger.scrollIntoView({ block: 'center', inline: 'nearest' })
                        trigger.click()
                        return true
                    }
                }

                const progressBars = Array.from(root.querySelectorAll<HTMLElement>('[role="progressbar"]'))
                const mobileBar = progressBars.find(bar => {
                    const label = (bar.getAttribute('aria-label') ?? '').toLowerCase()
                    return (
                        label.includes('mobile') ||
                        label.includes('bing app') ||
                        label.includes('application') ||
                        label.includes('sapphire')
                    )
                })
                const mobileTrigger = mobileBar?.closest('button, a[data-rac], [role="button"]') as HTMLElement | null
                if (mobileTrigger) {
                    mobileTrigger.scrollIntoView({ block: 'center', inline: 'nearest' })
                    mobileTrigger.click()
                    return true
                }

                return false
            }, scopeSelector)

            if (clicked && (await this.waitForPanel())) {
                return true
            }
        }

        return false
    }

    async clickCheckInCta(): Promise<boolean> {
        await this.scrollClaimPanelContent()

        const checkInPattern = /check\s*in|open\s*(the\s*)?bing|get\s*started|start|commencer|ouvrir|abrir/i
        const skipPattern = /close|fermer|cancel|how it works|comment|learn more|view|error|nothing/i

        const buttonScopes = ['[role="dialog"] button', '[role="dialog"] [role="button"]', 'button']
        for (const scope of buttonScopes) {
            const buttons = this.page.locator(scope)
            const count = await buttons.count()
            for (let index = 0; index < count; index++) {
                const button = buttons.nth(index)
                const text = ((await button.textContent().catch(() => '')) ?? '').trim()
                if (!text || skipPattern.test(text) || !checkInPattern.test(text)) {
                    continue
                }

                try {
                    await button.scrollIntoViewIfNeeded({ timeout: 5000 })
                    await button.click({ timeout: 5000 })
                    await this.page.waitForTimeout(800).catch(() => undefined)
                    return true
                } catch {
                    try {
                        await button.click({ timeout: 5000, force: true })
                        await this.page.waitForTimeout(800).catch(() => undefined)
                        return true
                    } catch {
                        continue
                    }
                }
            }
        }

        return false
    }

    async closePanel(fallbackUrl = URLS.dashboard): Promise<void> {
        const clicked = await this.page.evaluate(() => {
            const isVisibleElement = (el: Element): boolean => {
                const rect = el.getBoundingClientRect()
                const style = window.getComputedStyle(el)
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            }
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            const closeButton = buttons.find(button => {
                const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('slot') ?? ''}`.toLowerCase()
                return isVisibleElement(button) && (label.includes('close') || label.includes('fermer') || label.includes('cerrar'))
            })
            if (!closeButton) return false
            closeButton.click()
            return true
        })

        if (clicked) {
            await this.page.waitForTimeout(500).catch(() => undefined)
            return
        }

        if (fallbackUrl && !this.page.url().includes('/dashboard')) {
            await this.page.goto(fallbackUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
        }
    }
}

function uniqueScopes(scope: string): string[] {
    return [...new Set([scope, 'section#snapshot', 'section#streaks', 'main', 'body'])]
}
