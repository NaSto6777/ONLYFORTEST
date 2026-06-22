const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')

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

validateJsonFile('src/accounts.json', 'accounts')
validateJsonFile('src/config.json', 'config')
