import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { chromium } from 'patchright'
import { buildProxyConfig, resolveAccountSessionPath, setupCleanupHandlers } from '../utils.js'
import { paint, ansi } from './terminalUi.js'
import { pageHasCaptcha, printCaptchaPrompt, printChallengeCleared, waitUntilChallengeCleared } from './captchaWait.js'
import { setupDebug } from './setupDebug.js'
import { openTempMailInbox } from './tempMailBrowser.js'
import { advanceSecurityPasswordSetup, canStartSecurityPassword, needsSecurityPassword } from './accountSecuritySetup.js'
import { advanceMicrosoftSignup, createSignupState } from './microsoftSignupFlow.js'

const SETUP_TIMEOUT_MS = 45 * 60 * 1000

const JOIN_SELECTORS = [
    '#start-earning-rewards-link',
    'a#start-earning-rewards-link',
    'a[href*="/createNewUser"]',
    'a[aria-label*="start earning" i]',
    'a.cta.learn-more-btn'
]

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function generatePassword() {
    const token = crypto.randomBytes(10).toString('base64url')
    return `Msrb${token}1!`
}

function parseInviteUrl(rawUrl) {
    const url = new URL(rawUrl)
    if (!url.hostname.includes('rewards.bing.com')) {
        throw new Error('Invite link must be a rewards.bing.com URL')
    }

    const rh = url.searchParams.get('rh')
    const ref = url.searchParams.get('ref') || 'rafsrchae'

    if (!rh) {
        throw new Error('Invite link is missing the rh= referral parameter')
    }

    return {
        welcomeUrl: url.href,
        rh,
        ref,
        createUserPath: `/createNewUser?rh=${encodeURIComponent(rh)}&ref=${encodeURIComponent(ref)}`
    }
}

function isRewardsDashboard(urlString) {
    try {
        const url = new URL(urlString)
        if (url.hostname === 'account.microsoft.com') return true
        if (url.hostname !== 'rewards.bing.com') return false

        const blocked = ['/welcome', '/signin', '/signin-oidc', '/signup', '/join']
        if (blocked.some(prefix => url.pathname.toLowerCase().startsWith(prefix))) {
            return false
        }

        const allowed = ['/dashboard', '/earn', '/redeem', '/status', '/pointsbreakdown', '/account']
        return allowed.some(prefix => url.pathname.toLowerCase() === prefix || url.pathname.toLowerCase().startsWith(`${prefix}/`))
    } catch {
        return false
    }
}

function isMicrosoftAuthUrl(urlString) {
    try {
        const host = new URL(urlString).hostname
        return host.includes('login.live.com') || host.includes('signup.live.com') || host.includes('account.live.com')
    } catch {
        return false
    }
}

function shortUrl(urlString) {
    try {
        const url = new URL(urlString)
        return `${url.origin}${url.pathname}`
    } catch {
        return urlString.slice(0, 80)
    }
}

async function clickJoinRewards(page, invite) {
    setupDebug('WELCOME', 'Looking for Join Microsoft Rewards button')

    for (const selector of JOIN_SELECTORS) {
        const link = page.locator(selector).first()
        const visible = await link.isVisible().catch(() => false)
        if (!visible) continue

        setupDebug('WELCOME', 'Clicking join link', selector)
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
            link.click().catch(() => {})
        ])
        return true
    }

    const fallbackUrl = new URL(invite.createUserPath, 'https://rewards.bing.com').href
    setupDebug('WELCOME', 'Join button not found — opening createNewUser URL directly', fallbackUrl)
    await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    return true
}

async function saveDesktopSession(context, sessionBase) {
    await fs.promises.mkdir(sessionBase, { recursive: true })
    const cookies = await context.cookies()
    const cookiesPath = path.join(sessionBase, 'session_desktop.json')
    await fs.promises.writeFile(cookiesPath, JSON.stringify(cookies, null, 2))
    return cookies.length
}

export async function runAccountSetupBrowser({
    account,
    config,
    projectRoot,
    inviteUrl,
    useTempMail = true,
    generatedPassword = null,
    onSetupSuccess
}) {
    const invite = parseInviteUrl(inviteUrl)
    const proxy = buildProxyConfig(account)

    if (!account.password && generatedPassword) {
        account.password = generatedPassword
    }
    if (!account.password) {
        account.password = generatePassword()
    }

    let finished = false
    let savedCookies = 0
    let accountPersisted = false
    let sessionBase = null
    const startedAt = Date.now()
    const signupState = createSignupState()
    let lastLoggedSignupStep = ''

    async function persistAccountAfterSetup() {
        if (accountPersisted || !sessionBase) {
            return
        }

        savedCookies = await saveDesktopSession(context, sessionBase)
        await onSetupSuccess?.(account, { sessionBase, cookies: savedCookies })
        accountPersisted = true

        console.log('')
        console.log(paint(`✓ Account saved (${savedCookies} session cookies)`, ansi.green + ansi.bold))
        console.log(paint(`  Email:    ${account.email}`, ansi.dim))
        console.log(paint(`  Password: ${account.password}`, ansi.yellow))
        console.log(paint(`  Session:  ${sessionBase}`, ansi.dim))
        console.log('')
    }

    console.log('')
    console.log(paint(' SETUP ', ansi.bold + ansi.cyan))
    console.log(paint('─'.repeat(74), ansi.gray))
    console.log(paint(`Region:  ${account.geoLocale}`, ansi.dim))
    console.log(paint(`Invite:  ${invite.welcomeUrl}`, ansi.dim))
    console.log(paint(`Browser: visible (headless=false)`, ansi.green))
    console.log('')

    setupDebug('INIT', 'Launching Chromium', { headless: false, proxy: Boolean(proxy) })

    const browser = await chromium.launch({
        headless: false,
        ...(proxy ? { proxy } : {}),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=WebAuthentication,PasswordManagerOnboarding,PasswordManager,EnablePasswordsAccountStorage,Passkeys'
        ]
    })

    const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        locale: account.langCode || 'en'
    })

    let mailPage = null
    if (useTempMail) {
        const tempMail = await openTempMailInbox(context)
        mailPage = tempMail.page
        account.email = tempMail.email
        setupDebug('TEMP-MAIL', 'Using disposable email for signup', account.email)
        console.log(paint(`Temp email: ${account.email}`, ansi.yellow + ansi.bold))
        console.log(paint(`Password:   ${account.password}`, ansi.yellow))
        console.log(paint('(Not saved to accounts.json until signup succeeds)', ansi.dim))
        console.log('')
    }

    sessionBase = resolveAccountSessionPath(projectRoot, config.sessionPath, account.email)

    const page = await context.newPage()

    const captchaAssistState = { attempts: 0, lastAttemptAt: 0 }

    void waitUntilChallengeCleared(page, {
        assistState: captchaAssistState,
        shouldStop: () => finished,
        onChallenge: () => {
            setupDebug('CAPTCHA', 'Challenge detected — trying Accessible challenge flow')
            printCaptchaPrompt()
        },
        onCleared: () => {
            setupDebug('CAPTCHA', 'Challenge cleared — continuing')
            printChallengeCleared()
        }
    })

    setupDebug('WELCOME', 'Opening referral welcome page', invite.welcomeUrl)
    await page.goto(invite.welcomeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    setupDebug('WELCOME', 'Current page', shortUrl(page.url()))
    await clickJoinRewards(page, invite)
    setupDebug('AUTH', 'After join click', shortUrl(page.url()))

    ;(async () => {
        while (!finished && Date.now() - startedAt < SETUP_TIMEOUT_MS) {
            const currentUrl = page.url()

            if (
                currentUrl.includes('signup.live.com') &&
                signupState.securityNavStarted &&
                !signupState.securityPasswordSubmitted
            ) {
                signupState.securityNavStarted = false
                setupDebug('SECURITY', 'Back on signup — waiting for password before security page')
            }

            if (isMicrosoftAuthUrl(currentUrl) && !(await canStartSecurityPassword(page, signupState))) {
                const step = await advanceMicrosoftSignup(page, account, signupState, mailPage)
                if (
                    step !== 'waiting-code-quiet' &&
                    step !== 'code-filled-waiting' &&
                    step !== 'birthdate-filled-waiting' &&
                    step !== lastLoggedSignupStep
                ) {
                    setupDebug('SIGNUP', `Step: ${step}`, shortUrl(currentUrl))
                    lastLoggedSignupStep = step
                }
            } else if (needsSecurityPassword(signupState)) {
                const step = await advanceSecurityPasswordSetup(page, account, signupState)
                if (!step.startsWith('security-skip') && step !== 'security-waiting-password-form') {
                    setupDebug('SECURITY', `Step: ${step}`, shortUrl(currentUrl))
                }

                if (step === 'security-password-saved') {
                    setupDebug('DONE', 'Password saved on security page — persisting account', {
                        email: account.email
                    })
                    await persistAccountAfterSetup()
                }
            } else if (isRewardsDashboard(currentUrl)) {
                finished = true
                setupDebug('DONE', 'Rewards dashboard reached', { email: account.email })
                await persistAccountAfterSetup()
                break
            } else {
                setupDebug('LOOP', 'Waiting on user/browser', shortUrl(currentUrl))
            }

            let pollWait = 1500
            if (signupState.emailSubmitted && !signupState.codeSubmitted && !signupState.codeFilled) {
                pollWait = 2000
            } else if (signupState.codeSubmitted && !signupState.birthdateSubmitted) {
                pollWait = 400
            } else if (signupState.birthdateFilled && !signupState.birthdateSubmitted) {
                pollWait = 300
            } else if (signupState.securityPasswordFilled && !signupState.securityPasswordSubmitted) {
                pollWait = 400
            }
            await sleep(pollWait)
        }

        if (!finished) {
            setupDebug('TIMEOUT', 'Still in progress — finish signup in the browser, then Ctrl+C')
        }
    })().catch(error => {
        setupDebug('ERROR', error instanceof Error ? error.message : String(error))
    })

    setupCleanupHandlers(async () => {
        finished = true
        if (savedCookies > 0 && sessionBase) {
            setupDebug('EXIT', 'Session already saved from successful signup')
        }
        if (browser?.isConnected?.()) {
            await browser.close()
        }
    })

    setupDebug('READY', 'Flow: signup → birthdate → name → captcha → account.live.com/password/Change → save')
    console.log(paint('Tabs: Rewards signup + temp-mail.org', ansi.dim))
    console.log(paint('Complete any remaining steps manually. Ctrl+C to close.', ansi.dim))
    await new Promise(() => {})
}

export { generatePassword, parseInviteUrl }
