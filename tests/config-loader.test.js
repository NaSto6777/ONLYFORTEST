const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..')

test('saveConfig persists to src/config.json even when dist/config.json exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-cfg-'))
    const prevCwd = process.cwd()

    try {
        process.chdir(tmpDir)
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
        fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true })
        const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'src', 'config.json'), 'utf8'))
        const srcConfig = { ...baseConfig, clusters: 2 }
        const distConfig = { ...baseConfig, clusters: 1 }
        fs.writeFileSync(path.join(tmpDir, 'src', 'config.json'), JSON.stringify(srcConfig, null, 4))
        fs.writeFileSync(path.join(tmpDir, 'dist', 'config.json'), JSON.stringify(distConfig, null, 4))

        const loaderPath = path.join(root, 'dist', 'helpers', 'ConfigLoader.js')
        delete require.cache[require.resolve(loaderPath)]
        const { reloadConfig, saveConfig, getConfigFilePath } = require(loaderPath)

        assert.match(getConfigFilePath(), /[\\/]src[\\/]config\.json$/)
        assert.equal(reloadConfig().clusters, 2)

        await saveConfig({ ...reloadConfig(), clusters: 7 })

        assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, 'src', 'config.json'), 'utf8')).clusters, 7)
        assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, 'dist', 'config.json'), 'utf8')).clusters, 1)
    } finally {
        process.chdir(prevCwd)
        fs.rmSync(tmpDir, { recursive: true, force: true })
    }
})
