import path from 'path'
import readline from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import {
    appendAccountToFile,
    assertDailyAccountLimit,
    createAccountTemplate,
    findAccountByEmail,
    getDirname,
    getProjectRoot,
    loadAccounts,
    loadConfig,
    log,
    parseArgs,
    recordAccountAddedToday
} from '../utils.js'
import { paint, ansi } from './terminalUi.js'
import { generatePassword, parseInviteUrl, runAccountSetupBrowser } from './accountSetupBrowser.js'
import { setupDebug } from './setupDebug.js'

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)
const args = parseArgs()
const dev = args.dev === true
const MAX_PER_DAY = 3
const DEFAULT_GEO = 'TN'

function renderBanner() {
    console.log('')
    console.log(paint('╔' + '═'.repeat(74) + '╗', ansi.cyan))
    console.log(paint('║' + 'Add Microsoft Rewards Account (Referral Setup)'.padStart(61).padEnd(74) + '║', ansi.cyan))
    console.log(paint('╚' + '═'.repeat(74) + '╝', ansi.cyan))
    console.log('')
}

async function prompt(rl, label, defaultValue = '') {
    const suffix = defaultValue ? paint(` [${defaultValue}]`, ansi.dim) : ''
    const answer = (await rl.question(paint(`${label}${suffix}: `, ansi.bold + ansi.white))).trim()
    return answer || defaultValue
}

async function promptYesNo(rl, label, defaultYes = true) {
    const hint = defaultYes ? 'Y/n' : 'y/N'
    const answer = (await rl.question(paint(`${label} (${hint}): `, ansi.cyan))).trim().toLowerCase()
    if (!answer) return defaultYes
    return answer === 'y' || answer === 'yes'
}

async function collectInviteUrl(rl) {
    const defaultInvite = 'https://rewards.bing.com/welcome?ref=rafsrchae'
    const raw = args.invite || (await prompt(rl, 'Rewards invite / welcome link', defaultInvite))

    try {
        const invite = parseInviteUrl(raw)
        setupDebug('INVITE', 'Parsed referral link', invite)
        return raw.trim()
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
    }
}

async function main() {
    renderBanner()
    setupDebug('START', 'Add-account wizard started', { headless: false, maxPerDay: MAX_PER_DAY })

    assertDailyAccountLimit(projectRoot, MAX_PER_DAY)

    const rl = readline.createInterface({ input, output })

    try {
        const inviteUrl = await collectInviteUrl(rl)
        const useTempMail = args['no-temp-mail'] ? false : await promptYesNo(rl, 'Use temp-mail.org for a disposable email?', true)

        let email = args.email || ''
        let password = args.password || ''

        if (!useTempMail) {
            email = email || (await prompt(rl, 'Email'))
            if (!email.includes('@')) {
                throw new Error(`Invalid email: ${email}`)
            }
        } else {
            setupDebug('TEMP-MAIL', 'Email will be generated from temp-mail.org during browser setup')
        }

        if (!password) {
            password = generatePassword()
            setupDebug('PASSWORD', 'Generated account password', password)
            console.log(paint(`Generated password: ${password}`, ansi.yellow + ansi.bold))
        }

        const geoLocale = (args.geo || (await prompt(rl, 'Country code (geoLocale)', DEFAULT_GEO))).toUpperCase()

        const account = createAccountTemplate({
            email: email || 'pending@temp-mail.org',
            password,
            recoveryEmail: '',
            geoLocale
        })

        if (email) {
            const { data: accounts } = loadAccounts(projectRoot, dev)
            if (findAccountByEmail(accounts, email)) {
                throw new Error(`Account already exists in accounts.json: ${email}`)
            }
        }

        const { data: config } = loadConfig(projectRoot, dev)
        let savedToFile = false

        const persistAccountOnSuccess = async readyAccount => {
            if (savedToFile || !readyAccount.email || readyAccount.email === 'pending@temp-mail.org') {
                return
            }

            const { data: accounts } = loadAccounts(projectRoot, dev)
            if (findAccountByEmail(accounts, readyAccount.email)) {
                savedToFile = true
                setupDebug('SAVE', 'Account already exists in accounts.json', readyAccount.email)
                return
            }

            const record = {
                ...createAccountTemplate({
                    email: readyAccount.email,
                    password: readyAccount.password,
                    recoveryEmail: readyAccount.recoveryEmail || '',
                    geoLocale: readyAccount.geoLocale || DEFAULT_GEO,
                    langCode: readyAccount.langCode || 'en'
                }),
                ...(readyAccount.firstName ? { firstName: readyAccount.firstName } : {}),
                ...(readyAccount.lastName ? { lastName: readyAccount.lastName } : {}),
                ...(readyAccount.birthYear ? { birthYear: String(readyAccount.birthYear) } : {}),
                ...(readyAccount.birthMonth ? { birthMonth: readyAccount.birthMonth } : {}),
                ...(readyAccount.birthDay ? { birthDay: String(readyAccount.birthDay) } : {})
            }

            const filePath = appendAccountToFile(projectRoot, record, dev)
            recordAccountAddedToday(projectRoot)
            savedToFile = true
            setupDebug('SAVE', 'Account saved to accounts.json after successful signup', filePath)
            console.log('')
            console.log(paint(`✓ Saved to ${path.relative(projectRoot, filePath)}`, ansi.green + ansi.bold))
            console.log(paint(`  ${record.email} · geo=${record.geoLocale}`, ansi.dim))
            console.log('')
        }

        setupDebug('BROWSER', 'Starting visible browser setup flow')
        await runAccountSetupBrowser({
            account,
            config,
            projectRoot,
            inviteUrl,
            useTempMail,
            generatedPassword: password,
            onSetupSuccess: persistAccountOnSuccess
        })
    } finally {
        rl.close()
    }
}

main().catch(error => {
    console.log('')
    setupDebug('FATAL', error instanceof Error ? error.message : String(error))
    process.exit(1)
})
