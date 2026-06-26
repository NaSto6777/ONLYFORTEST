const childProcess = require('child_process')
const path = require('path')
const {
    renderStartBanner,
    renderStep,
    renderStepDone,
    renderStepFail,
    renderLaunchHandoff,
    stopSpinnerAndLog
} = require('./startupUi')
const { runAutoUpdate } = require('./run-auto-update')

const projectRoot = path.resolve(__dirname, '..')

function run(command, args, options = {}) {
    const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command
    const result = childProcess.spawnSync(executable, args, {
        stdio: options.stdio ?? 'inherit',
        shell: false,
        cwd: options.cwd ?? projectRoot,
        env: options.env ?? process.env
    })

    if (result.error) {
        throw new Error(`Failed to run ${options.label ?? command}: ${result.error.message}`)
    }

    if (result.status !== 0) {
        const error = new Error(`Command failed: ${options.label ?? command}`)
        error.exitCode = result.status ?? 1
        error.stdout = result.stdout
        error.stderr = result.stderr
        throw error
    }

    return result
}

function runNpm(args, options = {}) {
    if (process.env.npm_execpath) {
        return run(process.execPath, [process.env.npm_execpath, ...args], {
            ...options,
            label: `npm ${args.join(' ')}`
        })
    }

    return run('npm', args, { ...options, label: `npm ${args.join(' ')}` })
}

async function main() {
    renderStartBanner(projectRoot)

    renderStep('Checking for updates')
    try {
        stopSpinnerAndLog('Checking for updates')
        const updateResult = await runAutoUpdate({ argv: process.argv })
        if (updateResult.status === 'updated') {
            renderStepDone(`Checking for updates (updated to v${updateResult.remote?.version ?? 'latest'})`)
        } else if (updateResult.status === 'update-available' && updateResult.docker) {
            renderStepDone('Checking for updates (new version available — rebuild Docker image)')
        } else if (updateResult.status === 'failed') {
            renderStepFail('Checking for updates', 'check failed — continuing with local version')
        } else {
            renderStepDone('Checking for updates')
        }
    } catch (error) {
        renderStepFail('Checking for updates', 'check failed — continuing with local version')
        if (error instanceof Error && error.message) {
            console.error(error.message)
        }
    }

    renderStep('Building project')
    try {
        runNpm(['run', 'build'], {
            stdio: ['ignore', 'pipe', 'pipe']
        })
        renderStepDone('Building project')
    } catch (error) {
        renderStepFail('Building project', 'failed')
        if (error.stderr?.length) {
            console.error(error.stderr.toString())
        } else if (error.stdout?.length) {
            console.error(error.stdout.toString())
        }
        process.exit(error.exitCode ?? 1)
    }

    renderLaunchHandoff()

    run(process.execPath, [path.join(projectRoot, 'dist', 'index.js'), ...process.argv.slice(2)], {
        label: 'bot',
        stdio: 'inherit',
        env: {
            ...process.env,
            MSRB_LAUNCHED_VIA_START: '1'
        }
    })
}

main().catch(error => {
    console.error(`\x1b[31m[START]\x1b[0m ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})
