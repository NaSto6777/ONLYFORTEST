import { getDirname, getProjectRoot, log, parseArgs, validateEmail } from '../utils.js'
import { openBrowserSession } from './openBrowserSession.js'

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)

const args = parseArgs()
validateEmail(args.email)

openBrowserSession(args.email, { dev: args.dev === true, projectRoot }).catch(error => {
    log('ERROR', error.message)
    process.exit(1)
})
