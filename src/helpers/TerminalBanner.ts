import chalk from 'chalk'
import type { ConfigWorkers } from '../types/Config'

const WORKER_LABELS: Record<keyof ConfigWorkers, string> = {
    doDailySet: 'Daily Set',
    doSpecialPromotions: 'Special Promotions',
    doMorePromotions: 'More Promotions',
    doAppPromotions: 'App Promotions',
    doDesktopSearch: 'Desktop Search',
    doMobileSearch: 'Mobile Search',
    doDailyCheckIn: 'Daily Check-In',
    doReadToEarn: 'Read to Earn',
    doDailyStreak: 'Daily Streak',
    doRedeemGoal: 'Redeem Goal',
    doDashboardInfo: 'Dashboard Info',
    doClaimPoints: 'Claim Points',
    enforceCoreStreakProtectionGate: 'Streak Protection Gate'
}

interface RunPlanOptions {
    version: string
    edition: string
    totalAccounts: number
    enabledAccounts: number
    clusters: number
    headless: boolean
    workers: ConfigWorkers
    singleAccount?: string
}

interface AccountSummaryRow {
    email: string
    success: boolean
    collectedPoints: number
    initialPoints: number
    finalPoints: number
    duration: number
    error?: string
    missing?: boolean
}

function boxLine(content: string, width = 74): string {
    const visible = stripAnsi(content)
    const padding = Math.max(0, width - visible.length)
    return chalk.cyan('║') + content + ' '.repeat(padding) + chalk.cyan('║')
}

function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function boxTop(width = 74): string {
    return chalk.cyan(`╔${'═'.repeat(width)}╗`)
}

function boxSep(width = 74): string {
    return chalk.cyan(`╠${'═'.repeat(width)}╣`)
}

function boxBottom(width = 74): string {
    return chalk.cyan(`╚${'═'.repeat(width)}╝`)
}

function center(text: string, width: number): string {
    const len = stripAnsi(text).length
    const left = Math.max(0, Math.floor((width - len) / 2))
    return ' '.repeat(left) + text + ' '.repeat(Math.max(0, width - len - left))
}

function padVisible(text: string, width: number): string {
    const len = stripAnsi(text).length
    if (len >= width) return text
    return text + ' '.repeat(width - len)
}

const NASTO_BANNER_ART = [
    '  _   _    _    ____ _____ ___  ',
    ' | \\ | |  / \\  / ___|_   _/ _ \\ ',
    ' |  \\| | / _ \\ \\___ \\ | || | | |',
    ' | |\\  |/ ___ \\ ___) || || |_| |',
    ' |_| \\_/_/   \\_\\____/ |_| \\___/ '
]

function centerArtLine(line: string, width: number): string {
    const left = Math.max(0, Math.floor((width - line.length) / 2))
    return ' '.repeat(left) + line
}

export function renderStartupBanner(version: string, edition: string): void {
    const width = 74
    const art = NASTO_BANNER_ART.map(line => chalk.cyan(centerArtLine(line, width)))

    console.log('')
    console.log(boxTop(width))
    console.log(boxLine(center(chalk.bold.white('NASTO'), width), width))
    console.log(boxLine(center(chalk.dim(`v${version} · ${edition}`), width), width))
    console.log(boxLine(center(chalk.gray(`Node ${process.version}`), width), width))
    console.log(boxBottom(width))
    for (const line of art) {
        console.log(line)
    }
    console.log('')
}

export function renderRunPlan(options: RunPlanOptions): void {
    const width = 74
    const mode = options.singleAccount
        ? chalk.yellow(`Single account: ${options.singleAccount}`)
        : chalk.white(`${options.enabledAccounts} account(s) · ${options.clusters} cluster(s)`)

    const headless = options.headless ? chalk.green('ON') : chalk.yellow('OFF (visible browsers)')
    const edition = options.edition.includes('Core') ? chalk.yellow(options.edition) : chalk.cyan(options.edition)

    const workerEntries = Object.entries(WORKER_LABELS) as Array<[keyof ConfigWorkers, string]>
    const enabled = workerEntries.filter(([key]) => options.workers[key])
    const disabled = workerEntries.filter(([key]) => !options.workers[key] && key !== 'enforceCoreStreakProtectionGate')

    console.log(boxTop(width))
    console.log(boxLine(chalk.bold.cyan(' RUN PLAN '), width))
    console.log(boxSep(width))
    console.log(boxLine(` ${chalk.bold('Mode')}       ${mode}`, width))
    console.log(boxLine(` ${chalk.bold('Headless')}   ${headless}`, width))
    console.log(boxLine(` ${chalk.bold('Edition')}    ${edition}`, width))
    console.log(boxSep(width))
    console.log(boxLine(chalk.bold.white(' Enabled tasks '), width))

    const enabledChunks: string[] = []
    let current = ''
    for (const [, label] of enabled) {
        const token = chalk.green(`✓ ${label}`)
        const next = current ? `${current}   ${token}` : token
        if (stripAnsi(next).length > width - 4) {
            if (current) enabledChunks.push(current)
            current = token
        } else {
            current = next
        }
    }
    if (current) enabledChunks.push(current)
    for (const line of enabledChunks.length ? enabledChunks : [chalk.gray(' none ')]) {
        console.log(boxLine(` ${line}`, width))
    }

    if (disabled.length > 0) {
        console.log(boxLine(chalk.bold.gray(' Disabled '), width))
        let disabledLine = ''
        for (const [, label] of disabled) {
            const token = chalk.gray(`✗ ${label}`)
            const next = disabledLine ? `${disabledLine}   ${token}` : token
            if (stripAnsi(next).length > width - 4) {
                if (disabledLine) console.log(boxLine(` ${disabledLine}`, width))
                disabledLine = token
            } else {
                disabledLine = next
            }
        }
        if (disabledLine) console.log(boxLine(` ${disabledLine}`, width))
    }

    console.log(boxBottom(width))
    console.log('')
}

export function renderRunSummaryTable(rows: AccountSummaryRow[]): void {
    if (!rows.length) return

    const emailWidth = 30
    const header =
        chalk.bold.gray(' # ') +
        chalk.bold.gray('Email'.padEnd(emailWidth)) +
        chalk.bold.gray('Status'.padEnd(10)) +
        chalk.bold.gray('Collected'.padStart(10)) +
        chalk.bold.gray('Balance'.padStart(18)) +
        chalk.bold.gray('Time'.padStart(8))

    const line = chalk.gray('─'.repeat(78))

    console.log('')
    console.log(chalk.bold.cyan(' RUN SUMMARY '))
    console.log(line)
    console.log(header)
    console.log(line)

    rows.forEach((row, index) => {
        const shortEmail = row.email.length > emailWidth - 1 ? `${row.email.slice(0, emailWidth - 2)}…` : row.email

        let status = chalk.green('OK')
        if (row.missing) status = chalk.yellow('MISSING')
        else if (!row.success) status = chalk.red('FAILED')

        const collected =
            row.collectedPoints > 0
                ? chalk.green(`+${row.collectedPoints}`.padStart(10))
                : chalk.gray('+0'.padStart(10))

        const balance = row.missing
            ? chalk.gray('—'.padStart(18))
            : chalk.white(`${row.initialPoints} → ${row.finalPoints}`.padStart(18))

        const time = row.missing ? chalk.gray('—'.padStart(8)) : chalk.cyan(`${row.duration}s`.padStart(8))

        const errorSuffix = row.error ? chalk.red(`  ${row.error}`) : ''

        console.log(
            chalk.bold.white(String(index + 1).padStart(2, ' ')) +
                ' ' +
                chalk.white(shortEmail.padEnd(emailWidth)) +
                padVisible(status, 10) +
                collected +
                balance +
                time +
                errorSuffix
        )
    })

    console.log(line)

    const ok = rows.filter(row => row.success && !row.missing)
    const totalCollected = ok.reduce((sum, row) => sum + row.collectedPoints, 0)
    const totalInitial = ok.reduce((sum, row) => sum + row.initialPoints, 0)
    const totalFinal = ok.reduce((sum, row) => sum + row.finalPoints, 0)

    console.log(
        chalk.bold('Totals: ') +
            chalk.cyan(`${ok.length}/${rows.length} ok`) +
            chalk.gray(' │ ') +
            chalk.green(`+${totalCollected} pts`) +
            chalk.gray(' │ ') +
            chalk.white(`${totalInitial} → ${totalFinal}`)
    )
    console.log('')
}

export function renderRunEndBanner(
    processed: number,
    expected: number,
    totalCollected: number,
    totalInitial: number,
    totalFinal: number,
    minutes: string
): void {
    const width = 74
    console.log(boxTop(width))
    console.log(boxLine(center(chalk.bold.green('RUN COMPLETE'), width), width))
    console.log(boxSep(width))
    console.log(
        boxLine(
            ` ${chalk.bold('Accounts')}  ${chalk.cyan(`${processed}/${expected}`)}   ${chalk.bold('Runtime')}  ${chalk.cyan(`${minutes} min`)}`,
            width
        )
    )
    console.log(
        boxLine(
            ` ${chalk.bold('Points')}    ${chalk.green(`+${totalCollected}`)}   ${chalk.bold('Balance')}   ${chalk.white(`${totalInitial} → ${totalFinal}`)}`,
            width
        )
    )
    console.log(boxBottom(width))
    console.log('')
}
