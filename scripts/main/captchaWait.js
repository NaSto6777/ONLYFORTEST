import { paint, ansi } from './terminalUi.js'
import { setupDebug } from './setupDebug.js'

const CAPTCHA_IFRAME_SELECTORS = [
    'iframe[title="Human verification challenge"]',
    'iframe[title*="Human verification" i]',
    'iframe[token]',
    'iframe[src*="arkose"]',
    'iframe[src*="hsprotect"]',
    'iframe[src*="captcha"]',
    'iframe#enforcementFrame',
    '#enforcementFrame',
    '#px-captcha',
    '[data-testid="captcha"]',
    '#hipTemplateContainer'
]

const CAPTCHA_TEXT =
    /help us (beat the robots|protect your account)|verify you.?re human|solve the puzzle|unusual activity|press and hold|let.?s prove you.?re human|human verification challenge/i

const EMAIL_CODE_INPUTS = [
    '[data-testid="codeEntry"] input',
    'input[id^="codeEntry-"]',
    'input[name="otc"]',
    'input[name="code"]',
    'input[id*="code" i]',
    'input[aria-label*="code" i]',
    'input[placeholder*="code" i]',
    'input[type="tel"]',
    'input[inputmode="numeric"]',
    '#iOttText'
]

const ACCESSIBLE_CHALLENGE_SELECTORS = [
    'a[role="button"][aria-label="Accessible challenge"]',
    '[role="button"][aria-label="Accessible challenge"]',
    'a[aria-label="Accessible challenge"]',
    '[aria-label*="Accessible challenge" i]',
    'a[title*="Accessible" i]'
]

const CAPTCHA_OUTER_IFRAME_SELECTORS = [
    'iframe[title="Human verification challenge"]',
    'iframe[title*="Human verification" i]',
    'iframe[token]',
    'iframe[src*="hsprotect"]',
    'iframe[src*="arkose"]'
]

const PRESS_AGAIN_HOLD_MS = 6000

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export async function pageIsEmailCodeStep(page) {
    for (const selector of EMAIL_CODE_INPUTS) {
        if (await page.locator(selector).first().isVisible().catch(() => false)) {
            return true
        }
    }

    const bodyText = await page.locator('body').innerText().catch(() => '')
    return /enter (the |your )?code|verification code|we sent a code|sent you a code|check your email/i.test(bodyText)
}

export async function pageHasCaptcha(page) {
    if (await pageIsEmailCodeStep(page)) {
        return false
    }

    for (const selector of CAPTCHA_IFRAME_SELECTORS) {
        const visible = await page
            .locator(selector)
            .first()
            .isVisible()
            .catch(() => false)
        if (visible) return true
    }

    const bodyText = await page.locator('body').innerText().catch(() => '')
    return CAPTCHA_TEXT.test(bodyText)
}

async function waitForCaptchaIframes(page, timeoutMs = 30_000) {
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
        for (const selector of CAPTCHA_IFRAME_SELECTORS) {
            const iframe = page.locator(selector).first()
            if (await iframe.isVisible().catch(() => false)) {
                setupDebug('CAPTCHA', 'Found captcha iframe', selector)
                return selector
            }
        }
        await sleep(500)
    }

    return null
}

async function collectCaptchaFrames(page) {
    const frames = []
    const seen = new Set()

    const addFrame = frame => {
        if (!frame || seen.has(frame)) return
        seen.add(frame)
        frames.push(frame)
        for (const child of frame.childFrames()) {
            addFrame(child)
        }
    }

    for (const selector of CAPTCHA_IFRAME_SELECTORS) {
        const locators = page.locator(selector)
        const count = await locators.count().catch(() => 0)

        for (let index = 0; index < count; index++) {
            const element = locators.nth(index)
            const handle = await element.elementHandle().catch(() => null)
            const frame = handle ? await handle.contentFrame().catch(() => null) : null
            if (frame) {
                addFrame(frame)
            }
        }
    }

    for (const frame of page.frames()) {
        addFrame(frame)
    }

    return frames
}

async function findInFrames(frames, findFn) {
    for (const frame of frames) {
        const result = await findFn(frame)
        if (result) {
            return { frame, ...result }
        }
    }
    return null
}

async function findAccessibleChallengeButton(page) {
    const frames = await collectCaptchaFrames(page)

    return findInFrames(frames, async frame => {
        for (const selector of ACCESSIBLE_CHALLENGE_SELECTORS) {
            const button = frame.locator(selector).first()
            if (await button.isVisible().catch(() => false)) {
                return { button, selector }
            }
        }

        const byRole = frame.getByRole('button', { name: /accessible challenge/i }).first()
        if (await byRole.isVisible().catch(() => false)) {
            return { button: byRole, selector: 'role=accessible challenge' }
        }

        return null
    })
}

async function waitForAccessibleChallengeButton(page, timeoutMs = 45_000) {
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
        const found = await findAccessibleChallengeButton(page)
        if (found) {
            return found
        }
        await sleep(800)
    }

    return null
}

function buildNestedFrameLocators(rootFrameLocator, depth = 4) {
    const frames = [rootFrameLocator]
    let current = rootFrameLocator

    for (let index = 0; index < depth; index++) {
        current = current.frameLocator('iframe')
        frames.push(current)
    }

    return frames
}

async function clickAccessibleInFrameTree(page) {
    for (const outerSelector of CAPTCHA_OUTER_IFRAME_SELECTORS) {
        if (!(await page.locator(outerSelector).first().isVisible().catch(() => false))) {
            continue
        }

        const outerFrame = page.frameLocator(outerSelector)
        const frameTree = buildNestedFrameLocators(outerFrame, 4)

        for (const frame of frameTree) {
            for (const selector of ACCESSIBLE_CHALLENGE_SELECTORS) {
                const accessible = frame.locator(selector).first()
                if (await accessible.isVisible().catch(() => false)) {
                    setupDebug('CAPTCHA', 'Clicking Accessible challenge', outerSelector)
                    await accessible
                        .click({ timeout: 8000 })
                        .catch(() => accessible.click({ force: true }).catch(() => {}))
                    return true
                }
            }

            const byRole = frame.getByRole('button', { name: /accessible challenge/i }).first()
            if (await byRole.isVisible().catch(() => false)) {
                setupDebug('CAPTCHA', 'Clicking Accessible challenge by role', outerSelector)
                await byRole.click({ timeout: 8000 }).catch(() => byRole.click({ force: true }).catch(() => {}))
                return true
            }
        }
    }

    return false
}

async function tryPressAndHoldChallenge(page) {
    const frames = await collectCaptchaFrames(page)

    for (const frame of frames) {
        const button = frame.getByRole('button', { name: /press and hold/i }).first()
        if (!(await button.isVisible().catch(() => false))) continue

        setupDebug('CAPTCHA', 'Press and hold — holding button 3.5s')
        const box = await button.boundingBox().catch(() => null)
        if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await page.mouse.down()
            await sleep(3500)
            await page.mouse.up()
            return true
        }

        await button.click({ timeout: 5000 }).catch(() => {})
        await sleep(3500)
        return true
    }

    for (const outerSelector of CAPTCHA_OUTER_IFRAME_SELECTORS) {
        const outerFrame = page.frameLocator(outerSelector)
        const frameTree = buildNestedFrameLocators(outerFrame, 4)

        for (const frame of frameTree) {
            const button = frame.getByRole('button', { name: /press and hold/i }).first()
            if (!(await button.isVisible().catch(() => false))) continue

            setupDebug('CAPTCHA', 'Press and hold via frameLocator', outerSelector)
            await button.click({ timeout: 5000 }).catch(() => {})
            await sleep(3500)
            return true
        }
    }

    return false
}

async function isPressAgainElement(locator) {
    const text = (await locator.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
    return /^press again$/i.test(text)
}

async function findPressAgainInLocatorContext(context) {
    const candidates = [
        context.locator('p', { hasText: /^press again$/i }),
        context.getByText(/^press again$/i),
        context.locator('p').filter({ hasText: /^press again$/i }),
        context.locator('[role="button"]', { hasText: /^press again$/i }),
        context.locator('button', { hasText: /^press again$/i }),
        context.locator('a[role="button"]', { hasText: /^press again$/i })
    ]

    for (const candidate of candidates) {
        const element = candidate.first()
        if (!(await element.isVisible().catch(() => false))) continue
        if (await isPressAgainElement(element)) {
            return element
        }
    }

    return null
}

async function findPressAgainTarget(page) {
    for (const outerSelector of CAPTCHA_OUTER_IFRAME_SELECTORS) {
        const outerFrame = page.frameLocator(outerSelector)
        const frameTree = buildNestedFrameLocators(outerFrame, 4)

        for (const frame of frameTree) {
            const element = await findPressAgainInLocatorContext(frame)
            if (element) {
                return { element, source: outerSelector }
            }
        }
    }

    const frames = await collectCaptchaFrames(page)
    for (const frame of frames) {
        const element = await findPressAgainInLocatorContext(frame)
        if (element) {
            return { element, source: 'frame-handle' }
        }
    }

    return null
}

async function holdPressOnLocator(page, locator, holdMs = PRESS_AGAIN_HOLD_MS) {
    await locator.scrollIntoViewIfNeeded().catch(() => {})

    const box = await locator.boundingBox().catch(() => null)
    if (box) {
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        setupDebug('CAPTCHA', `Press and hold on target for ${holdMs / 1000}s`, { x: Math.round(x), y: Math.round(y) })
        await page.mouse.move(x, y)
        await page.mouse.down()
        await sleep(holdMs)
        await page.mouse.up()
        return true
    }

    setupDebug('CAPTCHA', 'Bounding box missing — force-clicking Press again target')
    await locator.click({ timeout: 5000, force: true }).catch(() => {})
    await sleep(holdMs)
    return true
}

async function waitUntilChallengeControlEnabled(locator, timeoutMs = 45_000) {
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
        const disabled = await locator.getAttribute('aria-disabled').catch(() => null)
        const opacity = await locator.evaluate(element => getComputedStyle(element).opacity).catch(() => '1')

        if (disabled !== 'true' && Number(opacity) > 0.5) {
            return true
        }

        await sleep(400)
    }

    return false
}

async function waitForPressAgainTarget(page, timeoutMs = 90_000) {
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
        const found = await findPressAgainTarget(page)
        if (found) {
            return found
        }
        await sleep(500)
    }

    return null
}

export async function tryAccessibleCaptchaAssist(page) {
    await page.bringToFront().catch(() => {})

    const iframeSelector = await waitForCaptchaIframes(page, 25_000)
    if (!iframeSelector) {
        setupDebug('CAPTCHA', 'Captcha iframe not visible yet')
        return false
    }

    await sleep(2000)

    setupDebug('CAPTCHA', 'Waiting for Accessible challenge inside iframe tree')
    let clickedAccessible = await clickAccessibleInFrameTree(page)

    if (!clickedAccessible) {
        const accessible = await waitForAccessibleChallengeButton(page, 30_000)
        if (!accessible) {
            setupDebug('CAPTCHA', 'Accessible challenge not found — trying Press and hold')
            const held = await tryPressAndHoldChallenge(page)
            if (!held) {
                setupDebug('CAPTCHA', 'Could not solve CAPTCHA automatically — complete it in the browser')
                return false
            }
            await sleep(2000)
        } else {
            setupDebug('CAPTCHA', 'Waiting for Accessible challenge to become active', accessible.selector)
            await waitUntilChallengeControlEnabled(accessible.button)

            setupDebug('CAPTCHA', 'Clicking Accessible challenge via frame handle')
            await accessible.button
                .click({ timeout: 8000 })
                .catch(() => accessible.button.click({ force: true }).catch(() => {}))
            clickedAccessible = true
        }
    }

    if (!clickedAccessible && !(await pageHasCaptcha(page))) {
        return true
    }

    if (!clickedAccessible) {
        return false
    }

    await sleep(1500)
    setupDebug('CAPTCHA', 'Waiting for "Press again" text inside iframe')
    printPressAgainWaitPrompt()

    const pressAgain = await waitForPressAgainTarget(page)
    if (!pressAgain) {
        setupDebug('CAPTCHA', '"Press again" did not appear in time — complete CAPTCHA manually')
        return false
    }

    setupDebug('CAPTCHA', '"Press again" visible — holding mouse down 6s')
    printPressAgainReadyPrompt()

    const pressed = await holdPressOnLocator(page, pressAgain.element, PRESS_AGAIN_HOLD_MS)
    await sleep(2500)

    if (!(await pageHasCaptcha(page))) {
        setupDebug('CAPTCHA', 'CAPTCHA cleared after Press again hold')
        return true
    }

    setupDebug('CAPTCHA', 'CAPTCHA still visible — retrying Press again hold once')
    const retryTarget = await findPressAgainTarget(page)
    if (retryTarget) {
        await holdPressOnLocator(page, retryTarget.element, PRESS_AGAIN_HOLD_MS)
        await sleep(2500)
    }

    return !(await pageHasCaptcha(page))
}

export async function waitUntilChallengeCleared(page, options = {}) {
    const pollMs = options.pollMs ?? 1500
    const onChallenge = options.onChallenge ?? (() => {})
    const onCleared = options.onCleared ?? (() => {})
    const shouldStop = options.shouldStop ?? (() => false)
    const assistState = options.assistState ?? { attempts: 0, lastAttemptAt: 0 }

    let notified = false

    while (!shouldStop()) {
        if (await pageIsEmailCodeStep(page)) {
            if (notified) {
                onCleared()
                notified = false
            }
            await sleep(pollMs)
            continue
        }

        const challenged = await pageHasCaptcha(page)

        if (challenged) {
            if (!notified) {
                onChallenge()
                notified = true
            }

            const sinceLastAttempt = Date.now() - (assistState.lastAttemptAt || 0)
            if (assistState.attempts < 8 && sinceLastAttempt > 12_000) {
                assistState.attempts += 1
                assistState.lastAttemptAt = Date.now()
                await tryAccessibleCaptchaAssist(page).catch(error => {
                    setupDebug(
                        'CAPTCHA',
                        `Accessible challenge assist attempt ${assistState.attempts} failed`,
                        error instanceof Error ? error.message : String(error)
                    )
                })
            }

            await sleep(pollMs)
            continue
        }

        if (notified) {
            const stillOnSignup = page.url().includes('signup.live.com') || page.url().includes('login.live.com')
            const captchaIframeVisible = await page
                .locator('iframe[src*="hsprotect"], iframe[title="Human verification challenge"]')
                .first()
                .isVisible()
                .catch(() => false)

            if (stillOnSignup && captchaIframeVisible) {
                await sleep(pollMs)
                continue
            }

            onCleared()
            notified = false
            assistState.attempts = 0
            assistState.lastAttemptAt = 0
            await sleep(1000)
            continue
        }

        await sleep(pollMs)
    }
}

export function printCaptchaPrompt() {
    console.log('')
    console.log(paint('⏸  CAPTCHA detected', ansi.bold + ansi.yellow))
    console.log(paint('   Targeting Human verification iframe → Accessible challenge → PRESS AGAIN', ansi.white))
    console.log('')
}

export function printPressAgainWaitPrompt() {
    console.log(paint('   Accessible challenge clicked — waiting for PRESS AGAIN…', ansi.dim))
}

export function printPressAgainReadyPrompt() {
    console.log(paint('   "Press again" visible — holding mouse down 6 seconds…', ansi.yellow))
}

export function printEmailCodePrompt() {
    console.log('')
    console.log(paint('📧  Email verification', ansi.bold + ansi.cyan))
    console.log(paint('   Fetching code from temp-mail.org and pasting it…', ansi.white))
    console.log('')
}

export function printChallengeCleared() {
    console.log(paint('✓  Continuing…', ansi.green))
}
