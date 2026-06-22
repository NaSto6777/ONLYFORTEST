import { paint, ansi } from './terminalUi.js'

function formatDetails(details) {
    if (details === undefined) return null

    if (typeof details === 'string') {
        if (details.length > 140) {
            return `${details.slice(0, 140)}…`
        }
        return details
    }

    if (typeof details === 'object' && details !== null) {
        const clone = { ...details }
        for (const key of Object.keys(clone)) {
            if (typeof clone[key] === 'string' && clone[key].length > 140) {
                clone[key] = `${clone[key].slice(0, 140)}…`
            }
        }
        return JSON.stringify(clone, null, 2)
    }

    return String(details)
}

export function setupDebug(step, message, details) {
    const time = new Date().toLocaleTimeString(undefined, { hour12: false })
    const label = paint(`[ADD-ACCOUNT][${time}][${step}]`, ansi.bold + ansi.cyan)
    const body = paint(message, ansi.white)
    const detailText = formatDetails(details)

    if (!detailText) {
        console.log(`${label} ${body}`)
        return
    }

    console.log(`${label} ${body}`)
    console.log(paint(detailText, ansi.dim))
}
