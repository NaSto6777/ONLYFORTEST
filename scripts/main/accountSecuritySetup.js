import { setupDebug } from './setupDebug.js'
import { pageHasCaptcha } from './captchaWait.js'

export const SECURITY_PASSWORD_URL = 'https://account.live.com/password/Change?'

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function needsSecurityPassword(state) {
    return Boolean(
        state.codeSubmitted &&
        state.birthdateSubmitted &&
        state.nameSubmitted &&
        !state.securityPasswordSubmitted
    )
}

export async function canStartSecurityPassword(page, state) {
    if (!needsSecurityPassword(state)) {
        return false
    }

    if (await pageHasCaptcha(page)) {
        return false
    }

    const url = page.url()
    if (url.includes('signup.live.com') || url.includes('login.live.com')) {
        return false
    }

    return true
}

async function isWelcomeNoteStep(page) {
    const bodyText = await page.locator('body').innerText().catch(() => '')
    return /a quick note about your microsoft account|your important things are right here|your privacy is our priority/i.test(
        bodyText
    )
}

async function isPrivacyNoticeStep(page) {
    const url = page.url()
    if (url.includes('privacynotice.account.microsoft.com')) {
        return true
    }

    const bodyText = await page.locator('body').innerText().catch(() => '')
    return /privacy statement|we value your privacy|microsoft privacy/i.test(bodyText)
}

async function dismissPrivacyNotice(page) {
    const candidates = [
        page.getByRole('button', { name: /^ok$/i }),
        page.getByRole('button', { name: /^got it$/i }),
        page.getByRole('button', { name: /^continue$/i }),
        page.getByRole('button', { name: /^accept$/i }),
        page.locator('button', { hasText: /^ok$/i }),
        page.locator('button', { hasText: /^got it$/i }),
        page.locator('button', { hasText: /^continue$/i }),
        page.locator('[data-testid="primaryButton"]')
    ]

    for (const candidate of candidates) {
        const button = candidate.first()
        if (!(await button.isVisible().catch(() => false))) continue
        if (!(await button.isEnabled().catch(() => true))) continue

        await button.click({ timeout: 5000 }).catch(() => button.click({ force: true }).catch(() => {}))
        setupDebug('SECURITY', 'Dismissed privacy notice')
        await sleep(2000)
        return true
    }

    return false
}

async function dismissWelcomeNote(page) {
    const okButton = page.getByRole('button', { name: /^ok$/i }).first()
    if (await okButton.isVisible().catch(() => false)) {
        await okButton.click().catch(() => {})
        setupDebug('SECURITY', 'Clicked OK on Microsoft account welcome note')
        await sleep(1500)
        return true
    }

    const fallback = page.locator('button', { hasText: /^ok$/i }).first()
    if (await fallback.isVisible().catch(() => false)) {
        await fallback.click().catch(() => {})
        setupDebug('SECURITY', 'Clicked OK (fallback)')
        await sleep(1500)
        return true
    }

    return false
}

async function isSecurityPasswordStep(page) {
    const passwordInputs = page.locator('input[type="password"]')
    const count = await passwordInputs.count().catch(() => 0)
    if (count >= 2) return true
    if (count === 1 && page.url().includes('account.live.com/password')) return true

    const bodyText = await page.locator('body').innerText().catch(() => '')
    return /change password|new password|create.*password|add.*password|choose a password/i.test(bodyText)
}

async function fillPasswordInput(page, input, value, label) {
    await input.scrollIntoViewIfNeeded().catch(() => {})
    await input.click().catch(() => {})
    await input.fill('').catch(() => {})
    await input.fill(value).catch(() => {})

    let current = await input.inputValue().catch(() => '')
    if (current !== value) {
        await input.click({ clickCount: 3 }).catch(() => {})
        await page.keyboard.type(value, { delay: 25 }).catch(() => {})
        current = await input.inputValue().catch(() => '')
    }

    setupDebug('SECURITY', `Filled ${label}`, value ? '********' : '')
    return current === value
}

async function fillSecurityPasswords(page, password) {
    const namedSelectors = [
        'input[name="Password"]',
        'input[name="passwd"]',
        'input[name="NewPassword"]',
        'input[aria-label*="New password" i]',
        'input[aria-label*="Reenter" i]',
        'input[aria-label*="Confirm" i]'
    ]

    for (const selector of namedSelectors) {
        const field = page.locator(selector).first()
        if (await field.isVisible().catch(() => false)) {
            await fillPasswordInput(page, field, password, selector)
        }
    }

    const inputs = page.locator('input[type="password"]')
    const count = await inputs.count().catch(() => 0)

    if (count < 1) {
        setupDebug('SECURITY', 'Password inputs not found yet', { count })
        return false
    }

    if (count === 1) {
        return fillPasswordInput(page, inputs.nth(0), password, 'Password')
    }

    const firstOk = await fillPasswordInput(page, inputs.nth(0), password, 'New password')
    const secondOk = await fillPasswordInput(page, inputs.nth(1), password, 'Confirm password')
    if (count >= 3) {
        await fillPasswordInput(page, inputs.nth(2), password, 'Confirm password (2)')
    }

    return firstOk && secondOk
}

function saveButtonCandidates(page) {
    return [
        page.getByRole('button', { name: /^save$/i }),
        page.getByRole('button', { name: /save password/i }),
        page.getByRole('button', { name: /change password/i }),
        page.locator('button[data-testid="primaryButton"]'),
        page.locator('[data-testid="primaryButton"]'),
        page.locator('button[type="submit"]'),
        page.locator('input[type="submit"]'),
        page.locator('#idBtn_SetPwd'),
        page.locator('button', { hasText: /^save$/i }),
        page.locator('button', { hasText: /save password/i }),
        page.locator('button', { hasText: /change password/i }),
        page.locator('input[type="submit"][value="Save"]'),
        page.locator('input[type="submit"][value="Save password"]'),
        page.getByRole('button', { name: /^next$/i }),
        page.locator('button', { hasText: /^next$/i }),
        page.locator('input[type="submit"][value="Next"]')
    ]
}

async function findEnabledSaveButton(page, timeoutMs = 6000) {
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
        for (const candidate of saveButtonCandidates(page)) {
            const button = candidate.first()
            if (!(await button.isVisible().catch(() => false))) continue
            if (!(await button.isEnabled().catch(() => false))) continue
            return button
        }

        await sleep(200)
    }

    return null
}

async function clickSaveButton(page) {
    const button = await findEnabledSaveButton(page, 8000)
    if (button) {
        await button.scrollIntoViewIfNeeded().catch(() => {})
        await button.click({ timeout: 8000 }).catch(() => button.click({ force: true }).catch(() => {}))
        setupDebug('SECURITY', 'Clicked Save')
        return true
    }

    const inputs = page.locator('input[type="password"]')
    const count = await inputs.count().catch(() => 0)
    if (count > 0) {
        const lastInput = inputs.nth(count - 1)
        await lastInput.focus().catch(() => {})
        await page.keyboard.press('Enter').catch(() => {})
        await sleep(1500)

        if (!(await isSecurityPasswordStep(page))) {
            setupDebug('SECURITY', 'Submitted password form via Enter')
            return true
        }
    }

    setupDebug('SECURITY', 'Save button not found or still disabled')
    return false
}

export async function advanceSecurityPasswordSetup(page, account, state) {
    if (state.securityPasswordSubmitted) {
        return 'security-skip'
    }

    if (!needsSecurityPassword(state)) {
        return 'security-skip'
    }

    const alreadyOnSecurity =
        state.securityNavStarted ||
        page.url().includes('account.live.com/password') ||
        page.url().includes('account.microsoft.com/security')

    if (!alreadyOnSecurity && !(await canStartSecurityPassword(page, state))) {
        return 'security-skip'
    }

    if (await pageHasCaptcha(page)) {
        return 'security-skip'
    }

    await page.bringToFront().catch(() => {})

    if (!state.securityNavStarted) {
        state.securityNavStarted = true
        setupDebug('SECURITY', 'Opening password change page', SECURITY_PASSWORD_URL)
        await page.goto(SECURITY_PASSWORD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
        await sleep(2500)
        return 'security-navigated'
    }

    if (!state.securityWelcomeDismissed && (await isWelcomeNoteStep(page))) {
        const dismissed = await dismissWelcomeNote(page)
        if (dismissed) {
            state.securityWelcomeDismissed = true
            return 'security-welcome-dismissed'
        }
        return 'security-welcome-waiting'
    }

    if (await isPrivacyNoticeStep(page)) {
        const dismissed = await dismissPrivacyNotice(page)
        if (dismissed) {
            if (!(await isSecurityPasswordStep(page))) {
                setupDebug('SECURITY', 'Re-opening password change page after privacy notice')
                await page.goto(SECURITY_PASSWORD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
                await sleep(2000)
            }
            return 'security-privacy-dismissed'
        }
        return 'security-privacy-waiting'
    }

    if (!(await isSecurityPasswordStep(page))) {
        if (!(await isWelcomeNoteStep(page))) {
            state.securityWelcomeDismissed = true
        }

        if (!page.url().includes('account.live.com/password')) {
            setupDebug('SECURITY', 'Navigating to password change page', shortUrl(page.url()))
            await page.goto(SECURITY_PASSWORD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
            await sleep(2000)
        }

        return 'security-waiting-password-form'
    }

    if (!state.securityPasswordFilled) {
        setupDebug('SECURITY', 'Filling account password on change-password page')
        const filled = await fillSecurityPasswords(page, account.password)
        if (!filled) {
            return 'security-password-fill-failed'
        }

        const inputs = page.locator('input[type="password"]')
        const count = await inputs.count().catch(() => 0)
        if (count > 0) {
            await inputs.nth(count - 1).blur().catch(() => {})
        }
        await sleep(600)
        state.securityPasswordFilled = true
    }

    if (await clickSaveButton(page)) {
        state.securityPasswordSubmitted = true
        await sleep(2500)
        return 'security-password-saved'
    }

    return 'security-password-filled'
}

function shortUrl(urlString) {
    try {
        const url = new URL(urlString)
        return `${url.origin}${url.pathname}`
    } catch {
        return urlString.slice(0, 80)
    }
}
