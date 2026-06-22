import chalk from 'chalk'
import type { LogLevel, Platform } from '../notifications/LogService'

const ACCOUNT_COLORS = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'white'] as const

const TASK_COLORS: Record<string, keyof typeof chalk> = {
    'APP-REWARD': 'cyan',
    'URL-REWARD': 'blue',
    'DAILY-SET': 'yellow',
    'APP-PROMOTIONS': 'cyan',
    'MORE-PROMOTIONS': 'yellow',
    'SPECIAL-ACTIVITY': 'magenta',
    'ACTIVITY': 'white',
    'READ-TO-EARN': 'green',
    'DAILY-CHECK-IN': 'green',
    'DAILY-STREAK': 'yellow',
    'CLAIM-POINTS': 'green',
    'DASHBOARD-INFO': 'gray',
    'DESKTOP-SEARCH': 'magenta',
    'MOBILE-SEARCH': 'blue',
    'REPORT-ACTIVITY-BROWSER': 'gray',
    MAIN: 'white'
}

export interface ConsoleLogFormatInput {
    level: LogLevel
    platform: Platform
    userName: string
    title: string
    message: string
    verbose: boolean
}

export interface ConsoleLogFormatResult {
    suppress: boolean
    line: string
}

function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function padVisible(text: string, width: number): string {
    const len = stripAnsi(text).length
    if (len >= width) return text
    return text + ' '.repeat(width - len)
}

function accountColor(userName: string): (text: string) => string {
    if (userName === 'MAIN') return chalk.bold.white
    let hash = 0
    for (const char of userName) hash = (hash + char.charCodeAt(0)) % ACCOUNT_COLORS.length
    const key = ACCOUNT_COLORS[hash] ?? 'white'
    const fn = chalk[key as keyof typeof chalk]
    return typeof fn === 'function' ? (fn as (text: string) => string) : chalk.white
}

function platformLabel(platform: Platform): string {
    if (platform === 'main') return chalk.bgCyan.black(' MAIN ')
    return platform ? chalk.bgBlue.white(' MOB ') : chalk.bgMagenta.white(' DESK ')
}

function parseFields(message: string): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const part of message.split(' | ')) {
        const eq = part.indexOf('=')
        if (eq === -1) continue
        const key = part.slice(0, eq).trim()
        let value = part.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        fields[key] = value
    }
    return fields
}

function friendlyTaskTitle(title: string): string {
    const overrides: Record<string, string> = {
        'DAILY-SET': 'Daily Set',
        'MORE-PROMOTIONS': 'More Promotions',
        'APP-PROMOTIONS': 'App Promotions',
        'SPECIAL-ACTIVITY': 'Special Activities',
        'READ-TO-EARN': 'Read to Earn',
        'APP-REWARD': 'App Reward',
        'URL-REWARD': 'Url Reward'
    }
    if (overrides[title]) return overrides[title]
    return title
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
}

function prettifyMachineTitle(title: string): string {
    if (!title.includes('_')) return title

    const ignored = new Set(['sapphire', 'appnewbonus', 'info', 'offer', 'bonus', 'app'])
    const parts = title
        .split('_')
        .filter(part => part.length > 0 && !ignored.has(part.toLowerCase()))

    if (!parts.length) return title.replace(/_/g, ' ')

    return parts.map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(' ')
}

function pointsText(value: string | number, bold = true): string {
    const text = `+${value} pts`
    return bold ? chalk.green.bold(text) : chalk.green(text)
}

function beautifyMessage(title: string, message: string, level: LogLevel): string {
    const fields = parseFields(message)

    const plusPoints = message.match(/^\+(\d+) points?/)
    if (plusPoints) {
        const label = fields.title ? prettifyMachineTitle(fields.title) : ''
        const progress = fields.progress ? chalk.dim(` (${fields.progress})`) : ''
        const labelText = label ? chalk.white(` · ${label}`) : ''
        return `${pointsText(plusPoints[1] ?? '0')}${labelText}${progress}`
    }

    if (message.includes('gainedPoints=') && fields.gainedPoints) {
        const gained = fields.gainedPoints
        const balance = fields.newBalance
        const balanceText = balance ? chalk.dim(` → ${balance}`) : ''
        return `${chalk.green('✓')} ${chalk.white('Reward')} ${pointsText(gained, false)}${balanceText}`
    }

    if (title === 'ACTIVITY' && message.startsWith('Processing activity')) {
        const label = fields.title ? prettifyMachineTitle(fields.title) : 'Activity'
        return `${chalk.cyan('▸')} ${chalk.white(label)}`
    }

    if (message.includes('Starting sapphire promotion')) {
        const label = fields.title ? prettifyMachineTitle(fields.title) : 'App promotion'
        const remaining = fields.remaining ? chalk.dim(` · ${fields.remaining} left`) : ''
        return `${chalk.cyan('▶')} ${chalk.white(label)}${remaining}`
    }

    if (message.startsWith('Starting Read to Earn')) {
        return `${chalk.cyan('▶')} ${chalk.white('Read to Earn')}`
    }

    const startedMatch = message.match(/^Started solving (\d+)/)
    if (startedMatch) {
        const label = friendlyTaskTitle(title)
        return `${chalk.cyan('▶')} ${chalk.white(label)} ${chalk.dim(`· ${startedMatch[1]} tasks`)}`
    }

    const allCompleteMatch = message.match(/^All "([^"]+)" items have(?: already)? been completed/)
    if (allCompleteMatch) {
        return `${chalk.green('✓')} ${chalk.white(allCompleteMatch[1])} ${chalk.green('complete')}`
    }

    const readMatch = message.match(/^Read article (\d+\/\d+) \| \+(\d+) points?/)
    if (readMatch) {
        return `${chalk.white('Read')} ${chalk.cyan(readMatch[1] ?? '')} ${pointsText(readMatch[2] ?? '0', false)}`
    }

    if (message.includes('Already complete')) {
        return `${chalk.dim('○')} ${chalk.dim(message)}`
    }

    if (level === 'warn') {
        return `${chalk.yellow('⚠')} ${chalk.yellow(message)}`
    }

    if (level === 'error') {
        return `${chalk.red('✗')} ${chalk.red(message)}`
    }

    if (level === 'debug') {
        return chalk.magenta.dim(message)
    }

    return chalk.white(message)
}

function shouldSuppressConsole(title: string, message: string, level: LogLevel, verbose: boolean): boolean {
    if (verbose || level !== 'info') return false

    if (title === 'REPORT-ACTIVITY-BROWSER') return true
    if (title === 'ACTIVITY' && message.includes('Found activity type')) return true
    if (title === 'URL-REWARD' && message.includes('Starting UrlReward')) return true
    if (title === 'APP-REWARD' && message.includes('Starting sapphire promotion')) return true
    if (title === 'APP-REWARD' && message.includes('Finished sapphire promotion')) return true

    return false
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function formatConsoleLog(input: ConsoleLogFormatInput): ConsoleLogFormatResult {
    const suppress = shouldSuppressConsole(input.title, input.message, input.level, input.verbose)
    if (suppress) {
        return { suppress: true, line: '' }
    }

    const time = chalk.dim(formatTime(new Date()))
    const account = padVisible(accountColor(input.userName)(input.userName.slice(0, 12)), 12)
    const platform = platformLabel(input.platform)
    const taskColor = TASK_COLORS[input.title] ?? 'gray'
    const taskFn = chalk[taskColor]
    const task =
        typeof taskFn === 'function'
            ? padVisible((taskFn as (text: string) => string)(chalk.bold(input.title)), 18)
            : padVisible(chalk.bold.gray(input.title), 18)

    const body = beautifyMessage(input.title, input.message, input.level)
    const line = `${time} ${chalk.gray('│')} ${account} ${platform} ${task} ${chalk.gray('│')} ${body}`

    return { suppress: false, line }
}
