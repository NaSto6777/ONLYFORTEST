const supportsColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

export const ansi = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    blue: '\x1b[34m',
    white: '\x1b[97m',
    gray: '\x1b[90m',
    red: '\x1b[31m',
    bgCyan: '\x1b[46m',
    bgBlack: '\x1b[40m'
}

export function paint(text, style) {
    if (!supportsColor || !style) return String(text)
    return `${style}${text}${ansi.reset}`
}

export function visibleLength(text) {
    return String(text).replace(/\x1b\[[0-9;]*m/g, '').length
}

export function padVisible(text, width, align = 'left') {
    const raw = String(text)
    const len = visibleLength(raw)
    if (len >= width) {
        if (len === visibleLength(raw.slice(0, width))) return raw
        let cut = raw
        while (visibleLength(cut) > width - 1 && cut.length > 0) cut = cut.slice(0, -1)
        return `${cut}…`
    }

    const pad = ' '.repeat(width - len)
    return align === 'right' ? pad + raw : raw + pad
}

function levelStyle(level) {
    const normalized = String(level ?? '').toLowerCase()
    if (normalized.includes('gold')) return ansi.yellow + ansi.bold
    if (normalized.includes('silver')) return ansi.white
    if (normalized.includes('bronze')) return ansi.yellow
    if (normalized.includes('level 1')) return ansi.gray
    if (normalized.includes('level 2')) return ansi.white
    if (normalized.includes('level 3')) return ansi.yellow + ansi.bold
    return ansi.cyan
}

function sessionBadge(sessionLabel) {
    if (sessionLabel === 'desktop + mobile') return paint('D+M', ansi.green)
    if (sessionLabel === 'desktop') return paint('DESK', ansi.blue)
    if (sessionLabel === 'mobile') return paint('MOB', ansi.magenta)
    if (sessionLabel === 'no session') return paint('NONE', ansi.red)
    return paint('?', ansi.gray)
}

function formatPoints(points) {
    if (points == null || Number.isNaN(points)) return paint('—', ansi.gray)
    const value = Number(points).toLocaleString('en-US')
    return paint(value, ansi.green + ansi.bold)
}

function formatStreak(streak) {
    if (streak == null || Number.isNaN(streak)) return paint('—', ansi.gray)
    const days = Number(streak)
    const style = days >= 7 ? ansi.yellow + ansi.bold : days > 0 ? ansi.cyan : ansi.gray
    return paint(`${days}d`, style)
}

function formatToday(todayPoints) {
    if (todayPoints == null || Number.isNaN(todayPoints)) return paint('—', ansi.gray)
    const value = Number(todayPoints)
    if (value <= 0) return paint('+0', ansi.gray)
    return paint(`+${value}`, ansi.green)
}

function shortenEmail(email, maxLen) {
    if (email.length <= maxLen) return email
    const [user, domain] = email.split('@')
    if (!domain) return `${email.slice(0, maxLen - 1)}…`
    const keep = Math.max(6, maxLen - domain.length - 2)
    return `${user.slice(0, keep)}…@${domain}`
}

function line(char = '─', width = 78) {
    return paint(char.repeat(width), ansi.gray)
}

function boxRow(columns, widths, border = '│') {
    const edge = paint(border, ansi.gray)
    const cells = columns.map((cell, index) => padVisible(cell, widths[index]))
    return edge + ' ' + cells.join(` ${edge} `) + ' ' + edge
}

function boxBorder(widths, left, mid, right) {
    const parts = widths.map(width => '─'.repeat(width + 2))
    return paint(left, ansi.gray) + parts.join(paint(mid, ansi.gray)) + paint(right, ansi.gray)
}

function centerVisible(text, width) {
    const len = visibleLength(text)
    if (len >= width) return text
    const left = Math.floor((width - len) / 2)
    const right = width - len - left
    return ' '.repeat(left) + text + ' '.repeat(right)
}

export function clearLine() {
    process.stdout.write('\r\x1b[K')
}

export function renderProgress(label, done, total) {
    const width = 24
    const ratio = total > 0 ? done / total : 0
    const filled = Math.round(ratio * width)
    const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
    clearLine()
    process.stdout.write(
        `${paint(label, ansi.dim)} ${paint(bar, ansi.cyan)} ${paint(`${done}/${total}`, ansi.bold)}`
    )
}

export function renderBanner(accountCount) {
    const innerWidth = 74
    const title = paint('Microsoft Rewards — Session Browser', ansi.bold + ansi.cyan)
    const subtitle = paint(`${accountCount} account(s) ready`, ansi.dim)

    console.log('')
    console.log(paint('╔' + '═'.repeat(innerWidth) + '╗', ansi.cyan))
    console.log(
        paint('║', ansi.cyan) + centerVisible(title, innerWidth) + paint('║', ansi.cyan)
    )
    console.log(
        paint('║', ansi.cyan) + centerVisible(subtitle, innerWidth) + paint('║', ansi.cyan)
    )
    console.log(paint('╚' + '═'.repeat(innerWidth) + '╝', ansi.cyan))
    console.log('')
}

export function renderAccountTable(rows) {
    const termWidth = process.stdout.columns || 100
    const emailWidth = Math.min(34, Math.max(22, termWidth - 58))

    const widths = [3, emailWidth, 8, 7, 7, 14, 6]
    const headers = [
        paint('#', ansi.bold),
        paint('Email', ansi.bold),
        paint('Points', ansi.bold),
        paint('Streak', ansi.bold),
        paint('Today', ansi.bold),
        paint('Level', ansi.bold),
        paint('Sess', ansi.bold)
    ]

    const top = boxBorder(widths, '┌', '┬', '┐')
    const headSep = boxBorder(widths, '├', '┼', '┤')
    const bottom = boxBorder(widths, '└', '┴', '┘')

    console.log(top)
    console.log(boxRow(headers, widths))
    console.log(headSep)

    for (const row of rows) {
        const stats = row.stats
        const email = row.enabled
            ? shortenEmail(row.email, emailWidth)
            : paint(shortenEmail(row.email, emailWidth - 6), ansi.dim) + paint(' OFF', ansi.red)

        const cells = [
            paint(String(row.index).padStart(2, ' '), ansi.bold + ansi.white),
            email,
            formatPoints(stats?.points),
            formatStreak(stats?.streak),
            formatToday(stats?.todayPoints),
            stats?.level ? paint(stats.level, levelStyle(stats.level)) : paint('—', ansi.gray),
            sessionBadge(row.sessionLabel)
        ]

        console.log(boxRow(cells, widths))
    }

    console.log(bottom)
    console.log('')
}

export function renderSummary(rows) {
    const withStats = rows.filter(row => row.stats)
    if (!withStats.length) return

    const totalPoints = withStats.reduce((sum, row) => sum + Number(row.stats.points ?? 0), 0)
    const totalToday = withStats.reduce((sum, row) => sum + Number(row.stats.todayPoints ?? 0), 0)
    const maxStreak = withStats.reduce((max, row) => Math.max(max, Number(row.stats.streak ?? 0)), 0)
    const sessionsOk = rows.filter(row => row.sessionLabel !== 'no session').length

    console.log(
        paint('Summary  ', ansi.bold) +
            paint(`accounts: ${rows.length}`, ansi.cyan) +
            paint('  │  ', ansi.gray) +
            paint(`sessions: ${sessionsOk}/${rows.length}`, ansi.blue) +
            paint('  │  ', ansi.gray) +
            paint(`total pts: ${totalPoints.toLocaleString('en-US')}`, ansi.green + ansi.bold) +
            paint('  │  ', ansi.gray) +
            paint(`today: +${totalToday}`, ansi.green) +
            paint('  │  ', ansi.gray) +
            paint(`best streak: ${maxStreak}d`, ansi.yellow)
    )
    console.log('')
}

export function renderPrompt(maxIndex) {
    return (
        paint('► Pick account number to open', ansi.bold + ansi.cyan) +
        paint(` (0 = all mobile, 1-${maxIndex}, close browser to switch, q to quit): `, ansi.dim)
    )
}

export function renderOpening(email) {
    console.log('')
    console.log(paint(`Launching browser for ${email}...`, ansi.bold + ansi.green))
    console.log(
        paint('When done: close the browser window, or press Enter in this terminal.', ansi.dim)
    )
    console.log('')
}
