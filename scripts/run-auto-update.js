const { UpdateManager } = require('./updater/UpdateManager')

async function runAutoUpdate(options = {}) {
    const updater = new UpdateManager(options)
    return updater.run({
        argv: options.argv ?? process.argv,
        env: options.env ?? process.env,
        dryRun: options.dryRun === true
    })
}

module.exports = {
    runAutoUpdate
}

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run')
    runAutoUpdate({ dryRun })
        .then(result => {
            if (result.status === 'failed') {
                process.exitCode = 1
            }
        })
        .catch(error => {
            console.error(`[UPDATER] ${error instanceof Error ? error.message : String(error)}`)
            process.exit(1)
        })
}
