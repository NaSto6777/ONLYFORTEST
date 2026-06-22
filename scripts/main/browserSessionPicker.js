import fs from 'fs'
import path from 'path'
import readline from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import {
    getDirname,
    getProjectRoot,
    log,
    parseArgs,
    loadConfig,
    loadAccounts,
    resolveAccountSessionPath,
    fetchAccountRewardsStats
} from '../utils.js'
import { openBrowserSession } from './openBrowserSession.js'
import {
    clearLine,
    renderAccountTable,
    renderBanner,
    renderOpening,
    renderProgress,
    renderPrompt,
    renderSummary
} from './terminalUi.js'

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)
const args = parseArgs()
const dev = args.dev === true
const skipStats = args['no-stats'] === true
const SESSION_TYPE = 'mobile'

function hasMobileSession(sessionLabel) {
    return sessionLabel === 'mobile' || sessionLabel === 'desktop + mobile'
}

function sessionStatus(sessionBase) {
    if (!fs.existsSync(sessionBase)) {
        return 'no session'
    }

    const hasDesktop = fs.existsSync(path.join(sessionBase, 'session_desktop.json'))
    const hasMobile = fs.existsSync(path.join(sessionBase, 'session_mobile.json'))

    if (hasDesktop && hasMobile) return 'desktop + mobile'
    if (hasDesktop) return 'desktop'
    if (hasMobile) return 'mobile'
    return 'empty folder'
}

async function fetchStatsWithProgress(candidates, config) {
    const total = candidates.length
    let done = 0

    if (!skipStats && total > 0) {
        renderProgress('Fetching live stats', done, total)
    }

    const statsResults = await Promise.all(
        candidates.map(async account => {
            const sessionBase = resolveAccountSessionPath(projectRoot, config.sessionPath, account.email)
            if (sessionStatus(sessionBase) === 'no session') {
                done += 1
                if (!skipStats) renderProgress('Fetching live stats', done, total)
                return null
            }

            try {
                const stats = skipStats ? null : await fetchAccountRewardsStats(sessionBase)
                done += 1
                if (!skipStats) renderProgress('Fetching live stats', done, total)
                return stats
            } catch {
                done += 1
                if (!skipStats) renderProgress('Fetching live stats', done, total)
                return null
            }
        })
    )

    if (!skipStats && total > 0) {
        clearLine()
    }

    return statsResults
}

async function listAccounts() {
    const { data: config } = loadConfig(projectRoot, dev)
    const { data: accounts } = loadAccounts(projectRoot, dev)
    const candidates = accounts.filter(account => account?.email)
    const statsResults = await fetchStatsWithProgress(candidates, config)

    const rows = []
    let index = 1

    for (let i = 0; i < candidates.length; i++) {
        const account = candidates[i]
        const sessionBase = resolveAccountSessionPath(projectRoot, config.sessionPath, account.email)

        rows.push({
            index,
            email: account.email,
            enabled: account.enabled !== false,
            stats: statsResults[i],
            sessionLabel: sessionStatus(sessionBase)
        })
        index += 1
    }

    return rows
}

async function promptAccountNumber(rows) {
    const rl = readline.createInterface({ input, output })

    try {
        while (true) {
            renderBanner(rows.length)
            renderAccountTable(rows)
            renderSummary(rows)

            const answer = await rl.question(renderPrompt(rows.length))
            const trimmed = answer.trim().toLowerCase()

            if (trimmed === 'q' || trimmed === 'quit' || trimmed === 'exit') {
                return null
            }

            const picked = Number.parseInt(trimmed, 10)

            if (picked === 0) {
                return { mode: 'all', rows: rows.filter(row => hasMobileSession(row.sessionLabel)) }
            }

            if (!Number.isFinite(picked) || picked < 1 || picked > rows.length) {
                console.log('')
                log('ERROR', `Invalid choice: "${answer.trim()}". Enter 0-${rows.length} (0 = all mobile), or q to quit.`)
                console.log('')
                continue
            }

            return { mode: 'one', row: rows[picked - 1] }
        }
    } finally {
        rl.close()
    }
}

async function main() {
    while (true) {
        const rows = await listAccounts()

        if (rows.length === 0) {
            log('ERROR', 'No accounts found in accounts.json')
            process.exit(1)
        }

        const selected = await promptAccountNumber(rows)
        if (!selected) {
            log('INFO', 'Goodbye.')
            break
        }

        if (selected.mode === 'all') {
            if (selected.rows.length === 0) {
                log('ERROR', 'No accounts with mobile sessions found')
                console.log('')
                continue
            }

            const skipped = rows.length - selected.rows.length
            if (skipped > 0) {
                log('WARN', `Skipping ${skipped} account(s) without a mobile session`)
            }

            log('INFO', `Opening ${selected.rows.length} mobile browser(s)...`)

            await Promise.all(
                selected.rows.map(async row => {
                    renderOpening(row.email)

                    try {
                        await openBrowserSession(row.email, {
                            dev,
                            projectRoot,
                            exitOnClose: false,
                            sessionType: SESSION_TYPE
                        })
                    } catch (error) {
                        clearLine()
                        log('ERROR', `${row.email}: ${error.message}`)
                    }
                })
            )
        } else {
            renderOpening(selected.row.email)

            try {
                await openBrowserSession(selected.row.email, {
                    dev,
                    projectRoot,
                    exitOnClose: false,
                    sessionType: SESSION_TYPE
                })
            } catch (error) {
                clearLine()
                log('ERROR', error.message)
            }
        }

        console.log('')
        log('INFO', 'Browser(s) closed — pick another account number, or q to quit.')
        console.log('')
    }
}

main().catch(error => {
    clearLine()
    log('ERROR', error.message)
    process.exit(1)
})
