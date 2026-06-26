const supportsColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

const ansi = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    white: '\x1b[97m',
    gray: '\x1b[90m',
    red: '\x1b[31m'
}

function paint(text, ...styles) {
    if (!supportsColor || !styles.length) return String(text)
    return `${styles.join('')}${text}${ansi.reset}`
}

function visibleLength(text) {
    return String(text).replace(/\x1b\[[0-9;]*m/g, '').length
}

function centerVisible(text, width) {
    const len = visibleLength(text)
    if (len >= width) return text
    const left = Math.floor((width - len) / 2)
    const right = width - len - left
    return ' '.repeat(left) + text + ' '.repeat(right)
}

function boxLine(content, width) {
    const pad = Math.max(0, width - visibleLength(content))
    return paint('║', ansi.cyan) + content + ' '.repeat(pad) + paint('║', ansi.cyan)
}

function readPackageVersion(projectRoot) {
    try {
        const pkg = require(require('path').join(projectRoot, 'package.json'))
        return pkg.version ?? 'unknown'
    } catch {
        return 'unknown'
    }
}

const NASTO_BANNER_ART = [
    '  _   _    _    ____ _____ ___  ',
    ' | \\ | |  / \\  / ___|_   _/ _ \\ ',
    ' |  \\| | / _ \\ \\___ \\ | || | | |',
    ' | |\\  |/ ___ \\ ___) || || |_| |',
    ' |_| \\_/_/   \\_\\____/ |_| \\___/ '
]

function centerArtLine(line, width) {
    const left = Math.max(0, Math.floor((width - line.length) / 2))
    return ' '.repeat(left) + line
}

function renderStartBanner(projectRoot) {
    const version = readPackageVersion(projectRoot)
    const width = 74
    const art = NASTO_BANNER_ART.map(line => paint(centerArtLine(line, width), ansi.cyan))

    console.log('')
    console.log(paint(`╔${'═'.repeat(width)}╗`, ansi.cyan))
    console.log(boxLine(centerVisible(paint('NASTO', ansi.bold + ansi.white), width), width))
    console.log(
        boxLine(
            centerVisible(
                paint(`v${version}`, ansi.dim) + paint(' · ', ansi.gray) + paint('Launcher', ansi.cyan),
                width
            ),
            width
        )
    )
    console.log(
        boxLine(centerVisible(paint(`Node ${process.version}`, ansi.gray), width), width)
    )
    console.log(paint(`╚${'═'.repeat(width)}╝`, ansi.cyan))
    for (const line of art) {
        console.log(line)
    }
    console.log('')
    console.log(paint(' PREP ', ansi.bold + ansi.cyan))
    console.log(paint('─'.repeat(width), ansi.gray))
}

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let spinnerIndex = 0
let spinnerTimer = null
let activeStep = ''

function clearLine() {
    process.stdout.write('\r\x1b[K')
}

function stopSpinner() {
    if (spinnerTimer) {
        clearInterval(spinnerTimer)
        spinnerTimer = null
    }
    clearLine()
}

function renderStep(label) {
    activeStep = label
    if (spinnerTimer) clearInterval(spinnerTimer)
    spinnerIndex = 0
    spinnerTimer = setInterval(() => {
        const frame = paint(spinnerFrames[spinnerIndex % spinnerFrames.length], ansi.cyan)
        spinnerIndex += 1
        clearLine()
        process.stdout.write(`${frame} ${paint(label, ansi.white)} ${paint('...', ansi.dim)}`)
    }, 90)
}

function stopSpinnerAndLog(label) {
    stopSpinner()
    console.log(`${paint('…', ansi.cyan)} ${paint(label, ansi.white)}`)
}

function renderStepDone(label, detail = 'done') {
    stopSpinner()
    console.log(`${paint('✓', ansi.green)} ${paint(label, ansi.white)} ${paint(detail, ansi.dim)}`)
}

function renderStepFail(label, detail) {
    stopSpinner()
    console.log(`${paint('✗', ansi.bold + ansi.red)} ${paint(label, ansi.white)} ${paint(detail, ansi.red)}`)
}

function renderStepSkip(label, detail) {
    stopSpinner()
    console.log(`${paint('○', ansi.gray)} ${paint(label, ansi.dim)} ${paint(detail, ansi.dim)}`)
}

function renderLaunchHandoff() {
    const width = 74
    console.log('')
    console.log(paint('─'.repeat(width), ansi.gray))
    console.log(
        `${paint('▶', ansi.green)} ${paint('Launching bot', ansi.bold + ansi.white)} ${paint('(Ctrl+C to stop)', ansi.dim)}`
    )
    console.log(paint('─'.repeat(width), ansi.gray))
    console.log('')
}

module.exports = {
    renderStartBanner,
    renderStep,
    renderStepDone,
    renderStepFail,
    renderStepSkip,
    renderLaunchHandoff,
    stopSpinner,
    stopSpinnerAndLog
}
