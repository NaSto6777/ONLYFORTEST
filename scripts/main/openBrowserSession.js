import fs from 'fs'
import { stdin as input } from 'process'
import { chromium } from 'patchright'
import { newInjectedContext } from 'fingerprint-injector'
import {
    getDirname,
    getProjectRoot,
    log,
    loadConfig,
    loadAccounts,
    findAccountByEmail,
    resolveAccountSessionPath,
    loadCookies,
    loadFingerprint,
    buildProxyConfig
} from '../utils.js'

export async function launchBrowserForAccount(email, options = {}) {
    const dev = options.dev === true
    const projectRoot = options.projectRoot ?? getProjectRoot(getDirname(import.meta.url))

    const { data: config } = loadConfig(projectRoot, dev)
    const { data: accounts } = loadAccounts(projectRoot, dev)

    const account = findAccountByEmail(accounts, email)
    if (!account) {
        throw new Error(`Account not found: ${email}`)
    }

    const sessionBase = resolveAccountSessionPath(projectRoot, config.sessionPath, email)

    if (!fs.existsSync(sessionBase)) {
        throw new Error(`Session directory does not exist: ${sessionBase}`)
    }

    if (!config.baseURL) {
        throw new Error('baseURL is not set in config.json')
    }

    const forcedSessionType = options.sessionType

    let cookies
    let sessionType

    if (forcedSessionType === 'mobile') {
        cookies = await loadCookies(sessionBase, 'mobile')
        sessionType = 'mobile'

        if (cookies.length === 0) {
            throw new Error(`No mobile session cookies found (${sessionBase})`)
        }
    } else if (forcedSessionType === 'desktop') {
        cookies = await loadCookies(sessionBase, 'desktop')
        sessionType = 'desktop'

        if (cookies.length === 0) {
            throw new Error(`No desktop session cookies found (${sessionBase})`)
        }
    } else {
        cookies = await loadCookies(sessionBase, 'desktop')
        sessionType = 'desktop'

        if (cookies.length === 0) {
            log('WARN', 'No desktop session cookies found, trying mobile session...')
            cookies = await loadCookies(sessionBase, 'mobile')
            sessionType = 'mobile'

            if (cookies.length === 0) {
                throw new Error(`No cookies found in desktop or mobile session (${sessionBase})`)
            }

            log('INFO', `Using mobile session (${cookies.length} cookies)`)
        }
    }

    const isMobile = sessionType === 'mobile'
    const fingerprintEnabled = isMobile ? account.saveFingerprint?.mobile : account.saveFingerprint?.desktop

    let fingerprint = null
    if (fingerprintEnabled) {
        fingerprint = await loadFingerprint(sessionBase, sessionType)
        if (!fingerprint) {
            throw new Error(
                `Fingerprint is enabled for ${sessionType} but file not found (${sessionBase}/session_fingerprint_${sessionType}.json)`
            )
        }
        log('INFO', `Loaded ${sessionType} fingerprint`)
    }

    const proxy = buildProxyConfig(account)

    if (account.proxy?.url && (!proxy || !proxy.server)) {
        throw new Error('Proxy is configured but invalid or incomplete')
    }

    const userAgent = fingerprint?.fingerprint?.navigator?.userAgent || fingerprint?.fingerprint?.userAgent || null

    log('INFO', `Session: ${email} (${sessionType})`)
    log('INFO', `  Cookies: ${cookies.length}`)
    log('INFO', `  Fingerprint: ${fingerprint ? 'Yes' : 'No'}`)
    log('INFO', `  User-Agent: ${userAgent || 'Default'}`)
    log('INFO', `  Proxy: ${proxy ? 'Yes' : 'No'}`)
    log('INFO', 'Launching browser...')

    const browser = await chromium.launch({
        headless: false,
        ...(proxy ? { proxy } : {}),
        args: [
            '--no-sandbox',
            '--mute-audio',
            '--disable-setuid-sandbox',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-spki-list',
            '--ignore-ssl-errors',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-user-media-security=true',
            '--disable-blink-features=Attestation',
            '--disable-features=WebAuthentication,PasswordManagerOnboarding,PasswordManager,EnablePasswordsAccountStorage,Passkeys',
            '--disable-save-password-bubble'
        ]
    })

    let context
    if (fingerprint) {
        context = await newInjectedContext(browser, { fingerprint })

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'credentials', {
                value: {
                    create: () => Promise.reject(new Error('WebAuthn disabled')),
                    get: () => Promise.reject(new Error('WebAuthn disabled'))
                }
            })
        })

        log('SUCCESS', 'Fingerprint injected into browser context')
    } else {
        context = await browser.newContext({
            viewport: isMobile ? { width: 375, height: 667 } : { width: 1366, height: 768 }
        })
    }

    if (cookies.length) {
        await context.addCookies(cookies)
        log('INFO', `Added ${cookies.length} cookies to context`)
    }

    return { browser, context, sessionType, email, projectRoot, config, account }
}

export async function openBrowserSession(email, options = {}) {
    const { browser, context, config } = await launchBrowserForAccount(email, options)

    const page = await context.newPage()
    await page.goto(config.baseURL, { waitUntil: 'domcontentloaded' })

    log('SUCCESS', 'Browser opened with session loaded')
    log('INFO', `Navigated to: ${config.baseURL}`)

    const exitOnClose = options.exitOnClose !== false
    if (exitOnClose) {
        log('INFO', 'Press Ctrl+C to close the browser')
    } else {
        log('INFO', 'Close the browser window, or press Enter in this terminal to pick another account')
    }

    return waitUntilBrowserClosed(browser, context, page, { exitOnClose })
}

function waitUntilBrowserClosed(browser, context, page, options = {}) {
    const exitOnClose = options.exitOnClose !== false

    return new Promise(resolve => {
        let settled = false
        let pollTimer = null

        const finish = async () => {
            if (settled) return
            settled = true
            cleanup()

            try {
                if (browser?.isConnected?.()) {
                    await browser.close()
                }
            } catch (error) {
                log('WARN', `Browser close: ${error.message}`)
            }

            if (exitOnClose) {
                process.exit(0)
            }

            resolve()
        }

        const onPageClose = () => {
            void (async () => {
                await new Promise(r => setTimeout(r, 300))

                if (settled) return

                if (!browser.isConnected()) {
                    await finish()
                    return
                }

                const openPages = context.pages().filter(p => !p.isClosed())
                if (openPages.length === 0) {
                    await finish()
                }
            })()
        }

        const onSigInt = () => {
            void finish()
        }
        const onSigTerm = () => {
            void finish()
        }
        const onDisconnected = () => {
            void finish()
        }
        const onContextClose = () => {
            void finish()
        }
        const onStdinData = chunk => {
            const text = chunk.toString()
            if (text.includes('\n') || text.includes('\r')) {
                void finish()
            }
        }

        const cleanup = () => {
            if (pollTimer) clearInterval(pollTimer)
            process.removeListener('SIGINT', onSigInt)
            process.removeListener('SIGTERM', onSigTerm)
            browser.removeListener('disconnected', onDisconnected)
            context.removeListener('close', onContextClose)
            page.removeListener('close', onPageClose)
            if (!exitOnClose && input.isTTY) {
                input.removeListener('data', onStdinData)
                input.pause()
            }
        }

        browser.on('disconnected', onDisconnected)
        context.on('close', onContextClose)
        page.on('close', onPageClose)
        process.on('SIGINT', onSigInt)
        process.on('SIGTERM', onSigTerm)

        if (!exitOnClose && input.isTTY) {
            input.setEncoding('utf8')
            input.resume()
            input.on('data', onStdinData)
        }

        pollTimer = setInterval(() => {
            if (settled) return

            if (!browser.isConnected()) {
                void finish()
                return
            }

            const openPages = context.pages().filter(p => !p.isClosed())
            if (openPages.length === 0) {
                void finish()
            }
        }, 1000)
    })
}
