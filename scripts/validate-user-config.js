const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')

function ensurePluginsConfig() {
    const targetPath = path.join(projectRoot, 'plugins', 'plugins.jsonc')
    if (fs.existsSync(targetPath)) {
        return
    }

    const examplePath = path.join(projectRoot, 'plugins', 'plugins.example.jsonc')
    if (!fs.existsSync(examplePath)) {
        console.warn('\x1b[33m[CONFIG]\x1b[0m plugins/plugins.example.jsonc is missing — Core may load without plugins.jsonc')
        return
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.copyFileSync(examplePath, targetPath)
    console.log('\x1b[36m[CONFIG]\x1b[0m Created plugins/plugins.jsonc from plugins.example.jsonc (Core disabled)')
}

function validateJsonFile(relativePath, label) {
    const filePath = path.join(projectRoot, relativePath)

    if (!fs.existsSync(filePath)) {
        return
    }

    const source = fs.readFileSync(filePath, 'utf8')

    try {
        JSON.parse(source)
    } catch (error) {
        const match = /position (\d+)/i.exec(String(error.message))
        let location = ''

        if (match) {
            const position = Number(match[1])
            const before = source.slice(0, position)
            const line = before.split('\n').length
            const column = before.length - before.lastIndexOf('\n')
            location = ` (line ${line}, column ${column})`
        }

        console.error('')
        console.error(`\x1b[31m[CONFIG]\x1b[0m Invalid JSON in ${relativePath}${location}`)
        console.error(`\x1b[33m${error.message}\x1b[0m`)
        console.error('')
        console.error('Common fixes:')
        console.error('  • Add a comma after each account block:  },')
        console.error('  • Remove trailing commas after the last property in an object')
        console.error('  • Validate the file at https://jsonlint.com')
        console.error('')
        console.error(`If you are setting up for the first time, copy ${label}.example.json:`)
        console.error(`  copy src\\${label}.example.json src\\${label}.json`)
        console.error('')
        process.exit(1)
    }
}

ensurePluginsConfig()
validateJsonFile('src/accounts.json', 'accounts')
validateJsonFile('src/config.json', 'config')
