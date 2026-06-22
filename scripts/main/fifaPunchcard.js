import fs from 'fs'
import path from 'path'
import {
    getDirname,
    getProjectRoot,
    log,
    parseArgs,
    loadConfig,
    loadAccounts,
    findAccountByEmail,
    resolveAccountSessionPath
} from '../utils.js'
import { launchBrowserForAccount } from './openBrowserSession.js'

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)
const args = parseArgs()
const dev = args.dev === true

const DEFAULT_PUNCHCARD_URL =
    'https://rewards.bing.com/earn/quest/ENWW_pcparent_FIFA26-ROW_PC_punchcard'

const TASK_BUTTONS = [
    'Go to quiz',
    'Create your card',
    'Start predicting',
    'Find out',
    'Play for your team',
    'Download the Bing app'
]

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function resolvePunchcardUrl() {
    if (typeof args.url === 'string' && args.url.trim()) {
        return args.url.trim()
    }
    return DEFAULT_PUNCHCARD_URL
}

function listRunnableAccounts() {
    const { data: config } = loadConfig(projectRoot, dev)
    const { data: accounts } = loadAccounts(projectRoot, dev)

    return accounts.filter(account => {
        if (!account?.email || account.enabled === false) {
            return false
        }

        const sessionBase = resolveAccountSessionPath(projectRoot, config.sessionPath, account.email)
        if (!fs.existsSync(sessionBase)) {
            return false
        }

        const hasDesktop = fs.existsSync(path.join(sessionBase, 'session_desktop.json'))
        const hasMobile = fs.existsSync(path.join(sessionBase, 'session_mobile.json'))
        return hasDesktop || hasMobile
    })
}

function resolveAccountsToRun() {
    const selector = typeof args.email === 'string' ? args.email : typeof args.account === 'string' ? args.account : ''

    if (selector.trim()) {
        const { data: accounts } = loadAccounts(projectRoot, dev)
        const account = findAccountByEmail(accounts, selector.trim())
        if (!account) {
            throw new Error(`Account not found: ${selector}`)
        }
        return [account]
    }

    return listRunnableAccounts()
}

async function findTaskButton(page, label) {
    const pattern = new RegExp(escapeRegex(label), 'i')

    const candidates = [
        page.getByRole('link', { name: pattern }),
        page.getByRole('button', { name: pattern }),
        page.locator('a, button').filter({ hasText: pattern })
    ]

    for (const locator of candidates) {
        const target = locator.first()
        if ((await target.count()) > 0) {
            return target
        }
    }

    return null
}

async function clickTaskAndCloseTab(context, page, label, punchcardUrl) {
    log('INFO', `  Task: ${label}`)

    const button = await findTaskButton(page, label)
    if (!button) {
        log('WARN', `  Button not found: ${label}`)
        return false
    }

    const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null)
    const mainUrlBefore = page.url()

    try {
        await button.scrollIntoViewIfNeeded()
        await button.click({ timeout: 15_000 })
    } catch (error) {
        log('WARN', `  Click failed for "${label}": ${error.message}`)
        return false
    }

    await sleep(1500)

    const popup = await popupPromise
    if (popup && !popup.isClosed()) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
        await sleep(2000)
        await popup.close().catch(() => {})
        log('INFO', `  Closed popup tab for "${label}"`)
    } else if (!page.isClosed() && page.url() !== mainUrlBefore && !page.url().includes('punchcard')) {
        await sleep(2000)
        log('INFO', `  Returned to punch card after "${label}"`)
        await page.goto(punchcardUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    }

    await sleep(1000)

    if (!page.isClosed() && !page.url().includes('punchcard')) {
        await page.goto(punchcardUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
        await sleep(1500)
    }

    return true
}

async function runPunchcardForAccount(account, punchcardUrl) {
    log('INFO', `Account: ${account.email}`)

    const { browser, context } = await launchBrowserForAccount(account.email, { dev, projectRoot })
    const page = await context.newPage()

    try {
        await page.goto(punchcardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await sleep(3000)

        if (page.url().includes('404') || (await page.getByText(/404|page does not exist/i).count()) > 0) {
            log('WARN', `Punch card not available for ${account.email} (404 or missing page)`)
            return { email: account.email, success: false, completed: 0, total: TASK_BUTTONS.length }
        }

        let completed = 0
        for (const label of TASK_BUTTONS) {
            const ok = await clickTaskAndCloseTab(context, page, label, punchcardUrl)
            if (ok) {
                completed += 1
            }
        }

        log('SUCCESS', `Finished ${account.email}: ${completed}/${TASK_BUTTONS.length} tasks clicked`)
        return { email: account.email, success: completed > 0, completed, total: TASK_BUTTONS.length }
    } finally {
        if (browser?.isConnected?.()) {
            await browser.close().catch(() => {})
        }
    }
}

async function main() {
    const punchcardUrl = resolvePunchcardUrl()
    const accounts = resolveAccountsToRun()

    if (!accounts.length) {
        log('ERROR', 'No runnable accounts found (need enabled account with a saved session)')
        process.exit(1)
    }

    console.log('')
    log('INFO', `FIFA punch card automation`)
    log('INFO', `URL: ${punchcardUrl}`)
    log('INFO', `Accounts: ${accounts.length}`)
    console.log('')

    const results = []

    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i]
        log('INFO', `[${i + 1}/${accounts.length}] Starting ${account.email}`)

        try {
            const result = await runPunchcardForAccount(account, punchcardUrl)
            results.push(result)
        } catch (error) {
            log('ERROR', `${account.email}: ${error.message}`)
            results.push({
                email: account.email,
                success: false,
                completed: 0,
                total: TASK_BUTTONS.length,
                error: error.message
            })
        }

        if (i < accounts.length - 1) {
            await sleep(2000)
        }
    }

    console.log('')
    log('INFO', 'Summary')
    for (const result of results) {
        const status = result.success ? 'OK' : 'FAIL'
        log('INFO', `  [${status}] ${result.email} — ${result.completed}/${result.total} tasks`)
    }
    console.log('')
}

main().catch(error => {
    log('ERROR', error.message)
    process.exit(1)
})
