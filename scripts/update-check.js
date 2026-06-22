const { runAutoUpdate } = require('./run-auto-update')

const dryRun = process.argv.includes('--dry-run')

runAutoUpdate({ dryRun })
    .then(result => {
        if (result.status === 'failed') process.exitCode = 1
    })
    .catch(error => {
        console.error(`[UPDATER] ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
    })
