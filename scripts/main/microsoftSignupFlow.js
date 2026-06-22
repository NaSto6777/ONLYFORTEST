import crypto from 'crypto'
import { setupDebug } from './setupDebug.js'
import { pageHasCaptcha, pageIsEmailCodeStep, printEmailCodePrompt } from './captchaWait.js'
import { pollVerificationEmail } from './tempMailBrowser.js'

const CODE_POLL_INTERVAL_MS = 15_000

const FIRST_NAMES = [
    'Ahmed',
    'Youssef',
    'Karim',
    'Omar',
    'Sami',
    'Hedi',
    'Amine',
    'Rami',
    'Leila',
    'Sara',
    'Nour',
    'Amira',
    'Yasmine',
    'Maya'
]
const LAST_NAMES = [
    'Ben Ali',
    'Trabelsi',
    'Gharbi',
    'Mansour',
    'Bouazizi',
    'Hammami',
    'Saidi',
    'Jebali',
    'Mezghani',
    'Khelifi',
    'Chaabane',
    'Dridi',
    'Ferchichi',
    'Nasri'
]

const GEO_COUNTRY_NAMES = {
    TN: 'Tunisia',
    US: 'United States',
    FR: 'France',
    DE: 'Germany',
    GB: 'United Kingdom'
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function pickSignupName(account) {
    if (account.firstName && account.lastName) {
        return { firstName: account.firstName, lastName: account.lastName }
    }

    const firstName = FIRST_NAMES[crypto.randomInt(FIRST_NAMES.length)]
    const lastName = LAST_NAMES[crypto.randomInt(LAST_NAMES.length)]
    account.firstName = firstName
    account.lastName = lastName
    return { firstName, lastName }
}

function pickBirthdate(account) {
    if (account.birthYear && account.birthMonth && account.birthDay) {
        return {
            year: String(account.birthYear),
            month: account.birthMonth,
            day: String(account.birthDay)
        }
    }

    const year = String(1990 + (account.email?.charCodeAt(2) ?? 5) % 10)
    const months = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December'
    ]
    const month = months[(account.email?.charCodeAt(3) ?? 3) % months.length]
    const day = String(10 + ((account.email?.charCodeAt(4) ?? 4) % 18))

    account.birthYear = year
    account.birthMonth = month
    account.birthDay = day
    return { year, month, day }
}

export function createSignupState() {
    return {
        createAccountClicked: false,
        emailFilled: false,
        emailSubmitted: false,
        emailSubmittedAt: 0,
        codeFilled: false,
        codeSubmitted: false,
        codePollStarted: false,
        lastCodePollAt: 0,
        codePollAttempt: 0,
        codeSubmitAttempts: 0,
        nameSubmitted: false,
        birthdateFilled: false,
        birthdateSubmitAttempts: 0,
        birthdateSubmitted: false,
        passwordSubmitted: false,
        securityNavStarted: false,
        securityWelcomeDismissed: false,
        securityPasswordFilled: false,
        securityPasswordSubmitted: false,
        seenMailIds: new Set()
    }
}

function createAccountLocators(page) {
    return [
        page.getByRole('button', { name: /create an account/i }),
        page.getByRole('link', { name: /create an account/i }),
        page.getByText('Create an account', { exact: true }),
        page.locator('[role="button"]', { hasText: 'Create an account' }),
        page.locator('span.fui-Link', { hasText: 'Create an account' }),
        page.locator('a', { hasText: 'Create an account' })
    ]
}

async function hasCreateAccountLink(page) {
    for (const locator of createAccountLocators(page)) {
        if (await locator.first().isVisible().catch(() => false)) {
            return true
        }
    }
    return false
}

async function clickCreateAccount(page) {
    for (const locator of createAccountLocators(page)) {
        const target = locator.first()
        const visible = await target.isVisible().catch(() => false)
        if (!visible) continue

        setupDebug('SIGNUP', 'Clicking "Create an account" on login page')
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {}),
            target.click({ timeout: 10_000 }).catch(() => target.click({ force: true }).catch(() => {}))
        ])
        await sleep(2000)
        setupDebug('SIGNUP', 'After Create an account', page.url().split('?')[0])
        return true
    }

    return false
}

async function fieldVisible(page, selectors) {
    for (const selector of selectors) {
        if (await page.locator(selector).first().isVisible().catch(() => false)) {
            return selector
        }
    }
    return null
}

async function fillField(page, selector, value, step) {
    const field = page.locator(selector).first()
    const current = await field.inputValue().catch(() => '')
    if (current === value) {
        return true
    }

    await field.fill(value).catch(() => {})
    setupDebug(step, `Filled ${selector}`, value)
    return true
}

async function clickNextButton(page, step) {
    if (step === 'VERIFY' && (await isMultiDigitCodeStep(page))) {
        const next = page.getByRole('button', { name: /^next$/i }).first()
        if (!(await next.isVisible().catch(() => false))) {
            return false
        }
    }

    const candidates = [
        page.getByRole('button', { name: /^next$/i }),
        page.locator('button[type="submit"]', { hasText: /^next$/i }),
        page.locator('input[type="submit"][value="Next"]'),
        page.getByRole('button', { name: 'Next', exact: true })
    ]

    if (step !== 'VERIFY') {
        candidates.push(page.locator('[data-testid="primaryButton"]'))
    }

    for (const locator of candidates) {
        const button = locator.first()
        if (!(await button.isVisible().catch(() => false))) continue
        if (!(await button.isEnabled().catch(() => true))) continue

        await button.click({ timeout: 5000 }).catch(() => button.click({ force: true }).catch(() => {}))
        setupDebug(step, 'Clicked "Next"')
        return true
    }

    return false
}

async function clickNamedButton(page, name, step) {
    if (name === 'Next') {
        return clickNextButton(page, step)
    }

    const button = page.getByRole('button', { name, exact: true }).first()
    if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {})
        setupDebug(step, `Clicked "${name}"`)
        return true
    }

    const inputSubmit = page.locator(`input[type="submit"][value="${name}"]`).first()
    if (await inputSubmit.isVisible().catch(() => false)) {
        await inputSubmit.click().catch(() => {})
        setupDebug(step, `Clicked submit "${name}"`)
        return true
    }

    return false
}

async function isCodeStep(page) {
    if (await isMultiDigitCodeStep(page)) {
        return true
    }

    return pageIsEmailCodeStep(page)
}

async function isMultiDigitCodeStep(page) {
    const codeEntry = page.locator('[data-testid="codeEntry"]')
    if (await codeEntry.isVisible().catch(() => false)) {
        const inputCount = await codeEntry.locator('input').count().catch(() => 0)
        return inputCount > 1
    }

    const splitInputs = page.locator('input[id^="codeEntry-"]')
    return (await splitInputs.count().catch(() => 0)) > 1
}

async function getCodeInputSelector(page) {
    if (await isMultiDigitCodeStep(page)) {
        return null
    }

    return fieldVisible(page, [
        'input[name="otc"]',
        'input[name="code"]',
        'input[id*="code" i]',
        'input[aria-label*="code" i]',
        'input[placeholder*="code" i]',
        'input[type="tel"]',
        'input[inputmode="numeric"]',
        '#iOttText'
    ])
}

async function fillMultiDigitCode(page, code, step) {
    const digits = String(code).replace(/\D/g, '')
    if (!digits) return false

    const inputs = page.locator('[data-testid="codeEntry"] input, input[id^="codeEntry-"]')
    const count = await inputs.count().catch(() => 0)
    if (!count) return false

    await page.bringToFront().catch(() => {})

    for (let index = 0; index < digits.length && index < count; index++) {
        const input = inputs.nth(index)
        await input.click().catch(() => {})
        await input.fill('').catch(() => {})
        await input.fill(digits[index]).catch(() => {})
        await sleep(120)
    }

    const lastInput = inputs.nth(Math.min(digits.length, count) - 1)
    await lastInput.dispatchEvent('input').catch(() => {})
    await lastInput.dispatchEvent('change').catch(() => {})
    await lastInput.blur().catch(() => {})
    await lastInput.press('Enter').catch(() => {})
    await sleep(2000)

    setupDebug(step, `Filled ${Math.min(digits.length, count)} code digit inputs`, digits)
    return true
}

async function waitForCodeStepToClear(page, timeoutMs = 12_000, { multiDigit = false } = {}) {
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
        const onMultiDigit = await isMultiDigitCodeStep(page)

        if (multiDigit && !onMultiDigit) {
            return true
        }

        if (!multiDigit && !(await isCodeStep(page))) {
            return true
        }

        if (await isNameStep(page)) {
            return true
        }

        if (await isBirthdateStep(page)) {
            return true
        }

        if (await isPasswordStep(page)) {
            return true
        }

        if (!onMultiDigit && (await pageHasCaptcha(page))) {
            return true
        }

        await sleep(500)
    }

    if (multiDigit) {
        return !(await isMultiDigitCodeStep(page))
    }

    return !(await isCodeStep(page))
}

async function fillVerificationCode(page, code, step) {
    if (await isMultiDigitCodeStep(page)) {
        return fillMultiDigitCode(page, code, step)
    }

    const codeSelector = await getCodeInputSelector(page)
    if (!codeSelector) return false
    return fillField(page, codeSelector, code, step)
}

async function submitVerificationCode(page, state, step) {
    await page.bringToFront().catch(() => {})
    await sleep(500)

    if (!(await isCodeStep(page)) && !(await isMultiDigitCodeStep(page))) {
        state.codeSubmitted = true
        return 'code-submitted'
    }

    const multiDigitFlow = (await isMultiDigitCodeStep(page)) || state.codeFilled

    if (multiDigitFlow) {
        setupDebug(step, '6-digit code filled — waiting for auto-advance (no Next button on this step)')
        const cleared = await waitForCodeStepToClear(page, 12_000, { multiDigit: true })
        if (cleared) {
            state.codeSubmitted = true
            setupDebug(step, 'Left code step after auto-advance')
            return 'code-submitted'
        }

        return 'code-filled-waiting'
    }

    if (await clickNextButton(page, step)) {
        state.codeSubmitted = true
        await sleep(2000)
        return 'code-submitted'
    }

    await page.keyboard.press('Enter').catch(() => {})
    await sleep(1500)

    if (!(await isCodeStep(page))) {
        state.codeSubmitted = true
        return 'code-submitted'
    }

    return 'code-filled-waiting'
}

async function isPasswordStep(page) {
    return Boolean(
        await fieldVisible(page, ['input[name="Password"]', 'input[name="passwd"]', 'input[type="password"]', '#PasswordForm', '#i0118'])
    )
}

async function isNameStep(page) {
    const bodyText = await page.locator('body').innerText().catch(() => '')
    if (/add your name/i.test(bodyText)) return true

    return Boolean(await findNameInput(page, 'first'))
}

async function isBirthdateStep(page) {
    const controls = page.locator(
        '[data-testid="birthdateControls"], #BirthMonthDropdown, #BirthDayDropdown, input[name="BirthYear"]'
    )
    if (await controls.first().isVisible().catch(() => false)) {
        return true
    }

    const bodyText = await page.locator('body').innerText().catch(() => '')
    return /add some details|date of birth|birth date|when were you born/i.test(bodyText)
}

async function isSignupEmailStep(page) {
    return Boolean(
        await fieldVisible(page, ['input[name="MemberName"]', 'input[name="Email"]', '#UsernameForm', 'input[type="email"]'])
    )
}

async function getSignupEmailSelector(page) {
    return fieldVisible(page, [
        'input[name="MemberName"]',
        'input[name="Email"]',
        '#UsernameForm',
        'input[type="email"]'
    ])
}

async function readDropdownValue(trigger) {
    const truncated = await trigger.locator('[data-testid="truncatedSelectedText"]').innerText().catch(() => '')
    if (truncated.trim()) {
        return truncated.trim()
    }

    const value = await trigger.getAttribute('value').catch(() => '')
    if (value?.trim()) {
        return value.trim()
    }

    return (await trigger.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
}

function dropdownValueMatches(selected, wanted, label) {
    if (!selected) {
        return false
    }

    const normalizedSelected = selected.trim().toLowerCase()
    const normalizedWanted = String(wanted).trim().toLowerCase()

    if (/day/i.test(label)) {
        return parseInt(normalizedSelected, 10) === parseInt(normalizedWanted, 10)
    }

    return (
        normalizedSelected === normalizedWanted ||
        normalizedSelected.includes(normalizedWanted) ||
        normalizedWanted.includes(normalizedSelected)
    )
}

async function closeOpenDropdown(page) {
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(80)
}

function dropdownTypeahead(value, label) {
    if (/day/i.test(label)) {
        return String(parseInt(value, 10))
    }

    if (/month/i.test(label)) {
        return String(value).slice(0, 3)
    }

    return String(value).slice(0, 3)
}

async function selectBirthdateDropdownFast(page, triggerId, value, label, step) {
    const trigger = page.locator(`#${triggerId}`).first()
    if (!(await trigger.isVisible({ timeout: 1500 }).catch(() => false))) {
        setupDebug(step, `${label} dropdown not found`, triggerId)
        return false
    }

    const current = await readDropdownValue(trigger)
    if (dropdownValueMatches(current, value, label)) {
        return true
    }

    await closeOpenDropdown(page)
    await trigger.click({ timeout: 3000 }).catch(() => trigger.click({ force: true }).catch(() => {}))
    await sleep(150)

    await page.keyboard.type(dropdownTypeahead(value, label), { delay: 12 }).catch(() => {})
    await page.keyboard.press('Enter').catch(() => {})
    await sleep(150)

    let selected = await readDropdownValue(trigger)
    if (dropdownValueMatches(selected, value, label)) {
        setupDebug(step, `Selected ${label}`, value)
        await closeOpenDropdown(page)
        return true
    }

    const option = page.getByRole('option', { name: String(value), exact: true }).first()
    if (await option.isVisible({ timeout: 400 }).catch(() => false)) {
        await option.click().catch(() => option.click({ force: true }).catch(() => {}))
        await sleep(120)
        selected = await readDropdownValue(trigger)
        if (dropdownValueMatches(selected, value, label)) {
            setupDebug(step, `Selected ${label}`, value)
            await closeOpenDropdown(page)
            return true
        }
    }

    if (/month/i.test(label)) {
        await trigger.click().catch(() => trigger.click({ force: true }).catch(() => {}))
        await sleep(100)
        await page.keyboard.type(String(value), { delay: 10 }).catch(() => {})
        await page.keyboard.press('Enter').catch(() => {})
        await sleep(120)
        selected = await readDropdownValue(trigger)
        if (dropdownValueMatches(selected, value, label)) {
            setupDebug(step, `Selected ${label}`, value)
            await closeOpenDropdown(page)
            return true
        }
    }

    setupDebug(step, `Failed to select ${label}`, { wanted: value, got: selected })
    await closeOpenDropdown(page)
    return false
}

async function selectCountryDropdownFast(page, countryName, step) {
    const trigger = page
        .locator('#CountryDropdown, [name="Country"][role="combobox"], [aria-label*="Country" i][role="combobox"]')
        .first()

    if (!(await trigger.isVisible({ timeout: 800 }).catch(() => false))) {
        return true
    }

    const current = await readDropdownValue(trigger)
    if (dropdownValueMatches(current, countryName, 'Country')) {
        return true
    }

    await closeOpenDropdown(page)
    await trigger.click({ timeout: 3000 }).catch(() => trigger.click({ force: true }).catch(() => {}))
    await sleep(150)
    await page.keyboard.type(dropdownTypeahead(countryName, 'Country'), { delay: 12 }).catch(() => {})
    await page.keyboard.press('Enter').catch(() => {})
    await sleep(150)

    const selected = await readDropdownValue(trigger)
    const ok = dropdownValueMatches(selected, countryName, 'Country')
    setupDebug(step, ok ? 'Selected Country' : 'Failed to select Country', { wanted: countryName, got: selected })
    await closeOpenDropdown(page)
    return ok
}

async function selectFluentDropdown(page, triggerSelectors, optionText, step, label) {
    const selectors = Array.isArray(triggerSelectors) ? triggerSelectors : [triggerSelectors]
    let trigger = null

    for (const selector of selectors) {
        const candidate = page.locator(selector).first()
        if (await candidate.isVisible().catch(() => false)) {
            trigger = candidate
            break
        }
    }

    if (!trigger) {
        setupDebug(step, `Dropdown not found: ${label}`)
        return false
    }

    const currentValue = await readDropdownValue(trigger)
    if (dropdownValueMatches(currentValue, optionText, label)) {
        setupDebug(step, `${label} already set`, optionText)
        return true
    }

    await closeOpenDropdown(page)
    await trigger.scrollIntoViewIfNeeded().catch(() => {})
    await trigger.click({ timeout: 5000 }).catch(() => trigger.click({ force: true }).catch(() => {}))
    await sleep(700)

    const escaped = String(optionText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const optionCandidates = [
        page.getByRole('option', { name: String(optionText), exact: true }),
        page.locator('[role="listbox"]:visible [role="option"]').filter({ hasText: new RegExp(`^${escaped}$`) }),
        page.locator('[role="option"]').filter({ hasText: new RegExp(`^${escaped}$`) })
    ]

    let optionClicked = false

    for (const options of optionCandidates) {
        const option = options.first()
        if (await option.isVisible({ timeout: 2500 }).catch(() => false)) {
            await option.scrollIntoViewIfNeeded().catch(() => {})
            await option.click().catch(() => option.click({ force: true }).catch(() => {}))
            optionClicked = true
            await sleep(400)
            break
        }
    }

    let selected = await readDropdownValue(trigger)

    if (!dropdownValueMatches(selected, optionText, label)) {
        const visibleOptions = page.locator('[role="listbox"]:visible [role="option"]')
        const optionCount = await visibleOptions.count().catch(() => 0)

        for (let index = 0; index < optionCount; index++) {
            const option = visibleOptions.nth(index)
            const text = (await option.innerText().catch(() => '')).trim()
            if (!dropdownValueMatches(text, optionText, label)) {
                continue
            }

            await option.scrollIntoViewIfNeeded().catch(() => {})
            await option.click().catch(() => option.click({ force: true }).catch(() => {}))
            optionClicked = true
            await sleep(400)
            selected = await readDropdownValue(trigger)
            break
        }
    }

    if (!dropdownValueMatches(selected, optionText, label)) {
        await closeOpenDropdown(page)
        await trigger.click().catch(() => trigger.click({ force: true }).catch(() => {}))
        await sleep(300)
        await page.keyboard.type(String(optionText), { delay: 45 }).catch(() => {})
        await sleep(300)
        await page.keyboard.press('Enter').catch(() => {})
        await sleep(400)
        selected = await readDropdownValue(trigger)
    }

    const ok = dropdownValueMatches(selected, optionText, label)
    if (ok) {
        setupDebug(step, `Selected ${label}`, optionText)
    } else {
        setupDebug(step, `Failed to select ${label}`, { wanted: optionText, got: selected, optionClicked })
    }

    await closeOpenDropdown(page)
    return ok
}

async function findNameInput(page, kind) {
    const isFirst = kind === 'first'
    const label = isFirst ? 'First name' : 'Last name'
    const nameAttrs = isFirst ? ['FirstName', 'firstName'] : ['LastName', 'lastName']

    const candidates = [
        page.getByRole('textbox', { name: new RegExp(`^${label}$`, 'i') }),
        page.getByLabel(label, { exact: true }),
        page.locator(`input[aria-label="${label}"]`),
        page.locator(`input[name="${nameAttrs[0]}"]`),
        page.locator(`input[name="${nameAttrs[1]}"]`),
        page.locator(`input[placeholder="${label}"]`),
        page.locator('label', { hasText: new RegExp(`^${label}$`, 'i') }).locator('xpath=ancestor::*[contains(@class,"fui-Input")]//input'),
        page.locator('label', { hasText: new RegExp(`^${label}$`, 'i') }).locator('xpath=following::input[1]')
    ]

    for (const candidate of candidates) {
        const input = candidate.first()
        if (await input.isVisible().catch(() => false)) {
            return input
        }
    }

    return null
}

async function fillFluentTextInput(page, input, value, step, label) {
    if (!input) {
        setupDebug(step, `Input not found: ${label}`)
        return false
    }

    await input.scrollIntoViewIfNeeded().catch(() => {})
    await input.click({ timeout: 5000 }).catch(() => input.click({ force: true }).catch(() => {}))
    await input.fill('').catch(() => {})
    await input.fill(value).catch(() => {})

    let current = await input.inputValue().catch(() => '')
    if (current !== value) {
        await input.click({ clickCount: 3 }).catch(() => {})
        await page.keyboard.press('Backspace').catch(() => {})
        await page.keyboard.type(value, { delay: 35 }).catch(() => {})
        current = await input.inputValue().catch(() => '')
    }

    setupDebug(step, `Filled ${label}`, value)
    return current === value
}

async function fillNameStep(page, account, step) {
    await page.bringToFront().catch(() => {})

    const { firstName, lastName } = pickSignupName(account)
    setupDebug(step, 'Using random name', `${firstName} ${lastName}`)

    const firstInput = await findNameInput(page, 'first')
    const lastInput = await findNameInput(page, 'last')

    if (!firstInput || !lastInput) {
        setupDebug(step, 'Name inputs not found', {
            first: Boolean(firstInput),
            last: Boolean(lastInput)
        })
        return false
    }

    const firstOk = await fillFluentTextInput(page, firstInput, firstName, step, 'First name')
    const lastOk = await fillFluentTextInput(page, lastInput, lastName, step, 'Last name')
    return firstOk && lastOk
}

async function fillBirthYearFast(page, year, step) {
    const yearInput = page.locator('input[name="BirthYear"], input[aria-label="Birth year"], #floatingLabelInput19').first()
    if (!(await yearInput.isVisible({ timeout: 1500 }).catch(() => false))) {
        setupDebug(step, 'Birth year input not visible')
        return false
    }

    const current = await yearInput.inputValue().catch(() => '')
    if (current === year) {
        return true
    }

    await yearInput.click().catch(() => yearInput.click({ force: true }).catch(() => {}))
    await yearInput.fill(year).catch(() => {})
    const filled = (await yearInput.inputValue().catch(() => '')) === year
    setupDebug(step, filled ? 'Filled Birth year' : 'Failed Birth year', year)
    return filled
}

async function fillBirthdateStep(page, account, step) {
    await page.bringToFront().catch(() => {})
    await closeOpenDropdown(page)

    const { year, month, day } = pickBirthdate(account)
    const countryName = GEO_COUNTRY_NAMES[account.geoLocale?.toUpperCase()] ?? GEO_COUNTRY_NAMES.TN

    setupDebug(step, 'Add some details — filling birthdate', `${month} ${day}, ${year} (${countryName})`)

    const countryOk = await selectCountryDropdownFast(page, countryName, step)
    const monthOk = await selectBirthdateDropdownFast(page, 'BirthMonthDropdown', month, 'Birth month', step)
    const dayOk = await selectBirthdateDropdownFast(page, 'BirthDayDropdown', day, 'Birth day', step)
    const yearOk = await fillBirthYearFast(page, year, step)

    if (!(countryOk && monthOk && dayOk && yearOk)) {
        setupDebug(step, 'Birthdate fill incomplete', { countryOk, monthOk, dayOk, yearOk })
    }

    return countryOk && monthOk && dayOk && yearOk
}

async function waitForEnabledNext(page, timeoutMs = 2000) {
    const next = page.getByRole('button', { name: /^next$/i }).first()
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
        if ((await next.isVisible().catch(() => false)) && (await next.isEnabled().catch(() => false))) {
            return next
        }

        await sleep(150)
    }

    return null
}

export async function advanceMicrosoftSignup(page, account, state, mailPage) {
    if (await pageHasCaptcha(page)) {
        return 'captcha'
    }

    if (state.emailSubmitted && !state.codeSubmitted) {
        if (state.codeFilled) {
            const advancedPastCode =
                !(await isMultiDigitCodeStep(page)) ||
                (await isNameStep(page)) ||
                (await isBirthdateStep(page)) ||
                (await isPasswordStep(page))

            if (advancedPastCode) {
                state.codeSubmitted = true
            } else {
                state.codeSubmitAttempts += 1
                const result = await submitVerificationCode(page, state, 'VERIFY')

                if (result === 'code-submitted') {
                    return result
                }

                if (state.codeSubmitAttempts >= 8 && !(await isCodeStep(page))) {
                    state.codeSubmitted = true
                    return 'code-submitted'
                }

                if (state.codeSubmitAttempts >= 8 && ((await isNameStep(page)) || (await pageHasCaptcha(page)))) {
                    state.codeSubmitted = true
                    return 'code-submitted'
                }

                return result
            }
        } else {

        if (!(await isCodeStep(page))) {
            state.codeSubmitted = true
            return 'past-code-step'
        }

        if (!state.codePollStarted) {
            state.codePollStarted = true
            printEmailCodePrompt()
            setupDebug(
                'VERIFY',
                `Waiting for Microsoft email — refreshing temp-mail.org every ${CODE_POLL_INTERVAL_MS / 1000}s`,
                account.email
            )
        }

        const sinceLastPoll = Date.now() - (state.lastCodePollAt || state.emailSubmittedAt || 0)
        if (sinceLastPoll < CODE_POLL_INTERVAL_MS) {
            return 'waiting-code-quiet'
        }

        state.lastCodePollAt = Date.now()
        state.codePollAttempt += 1
        setupDebug('VERIFY', `Refreshing temp-mail.org inbox (attempt ${state.codePollAttempt})`)

        const code = await pollVerificationEmail({
            email: account.email,
            mailPage,
            seen: state.seenMailIds
        })

        if (code) {
            const filled = await fillVerificationCode(page, code, 'VERIFY')
            if (filled) {
                state.codeFilled = true
                return submitVerificationCode(page, state, 'VERIFY')
            }

            setupDebug('VERIFY', 'Code received but input not found yet', code)
            return 'code-ready'
        }

        setupDebug('VERIFY', `No code yet — next refresh in ${CODE_POLL_INTERVAL_MS / 1000}s`)
        return 'waiting-code-quiet'
        }
    }

    if (state.codeSubmitted && !state.birthdateSubmitted && !(await isBirthdateStep(page))) {
        await page
            .locator('[data-testid="birthdateControls"], #BirthMonthDropdown')
            .first()
            .waitFor({ state: 'visible', timeout: 5000 })
            .catch(() => {})
    }

    if (!state.birthdateSubmitted && (await isBirthdateStep(page))) {
        if (!state.birthdateFilled) {
            state.birthdateFilled = await fillBirthdateStep(page, account, 'SIGNUP')
            if (!state.birthdateFilled) {
                return 'waiting-birthdate'
            }
        }

        state.birthdateSubmitAttempts += 1
        const next = await waitForEnabledNext(page, 1500)

        if (next) {
            await next.click({ timeout: 3000 }).catch(() => next.click({ force: true }).catch(() => {}))
            setupDebug('SIGNUP', 'Clicked "Next" on birthdate step')
            await sleep(1000)

            if (!(await isBirthdateStep(page))) {
                state.birthdateSubmitted = true
                return 'birthdate-submitted'
            }
        }

        if (state.birthdateSubmitAttempts >= 3) {
            setupDebug('SIGNUP', 'Birthdate Next still disabled — refilling fields')
            state.birthdateFilled = false
            state.birthdateSubmitAttempts = 0
            return 'birthdate-retry'
        }

        return 'birthdate-filled-waiting'
    }

    if (!state.nameSubmitted && (await isNameStep(page))) {
        setupDebug('SIGNUP', 'Filling name step')
        const filled = await fillNameStep(page, account, 'SIGNUP')
        if (filled && (await clickNextButton(page, 'SIGNUP'))) {
            state.nameSubmitted = true
            await sleep(2000)
            return 'name-submitted'
        }
        return filled ? 'name-filled' : 'waiting-name'
    }

    if (!state.createAccountClicked) {
        if (await hasCreateAccountLink(page)) {
            const clicked = await clickCreateAccount(page)
            if (clicked) {
                state.createAccountClicked = true
            }
            return clicked ? 'create-account-clicked' : 'create-account-failed'
        }

        if (await isSignupEmailStep(page)) {
            state.createAccountClicked = true
            setupDebug('SIGNUP', 'Signup form already open (no login link)')
        } else {
            setupDebug('SIGNUP', 'Waiting for login page with "Create an account" link')
            return 'waiting-login-page'
        }
    }

    if (!state.emailSubmitted && (await isSignupEmailStep(page)) && !(await isNameStep(page)) && !(await isBirthdateStep(page))) {
        const emailSelector = await getSignupEmailSelector(page)

        if (!emailSelector) {
            return 'waiting-signup-email'
        }

        await fillField(page, emailSelector, account.email, 'SIGNUP')
        state.emailFilled = true

        if (await clickNamedButton(page, 'Next', 'SIGNUP')) {
            state.emailSubmitted = true
            state.emailSubmittedAt = Date.now()
            state.lastCodePollAt = Date.now()
            await sleep(2000)
            return 'email-submitted'
        }

        return 'email-filled'
    }

    if (!state.passwordSubmitted && state.codeSubmitted && (await isPasswordStep(page))) {
        const passwordSelector = await fieldVisible(page, [
            'input[name="Password"]',
            'input[name="passwd"]',
            'input[type="password"]',
            '#PasswordForm',
            '#i0118'
        ])

        if (passwordSelector) {
            await fillField(page, passwordSelector, account.password, 'SIGNUP')
            if (await clickNamedButton(page, 'Next', 'SIGNUP')) {
                state.passwordSubmitted = true
                await sleep(2000)
                return 'password-submitted'
            }
            return 'password-filled'
        }
    }

    if (state.createAccountClicked && !state.emailSubmitted && (await hasCreateAccountLink(page))) {
        setupDebug('SIGNUP', 'Still on login page — retrying "Create an account"')
        state.createAccountClicked = false
        state.emailFilled = false
        return 'retry-create-account'
    }

    return 'idle'
}
