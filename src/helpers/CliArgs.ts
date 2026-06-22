import type { Account } from '../types/Account'

export function getCliAccountSelector(argv: string[] = process.argv): string | undefined {
    const flagIndex = argv.findIndex(arg => arg === '--account' || arg === '-email')
    if (flagIndex === -1) {
        return undefined
    }

    const value = argv[flagIndex + 1]?.trim()
    if (!value || value.startsWith('-')) {
        return undefined
    }

    return value
}

export function findAccountsBySelector(accounts: Account[], selector: string): Account[] {
    const normalized = selector.trim().toLowerCase()
    if (!normalized) {
        return []
    }

    const exactMatches = accounts.filter(
        account => typeof account.email === 'string' && account.email.toLowerCase() === normalized
    )
    if (exactMatches.length > 0) {
        return exactMatches
    }

    if (normalized.includes('@')) {
        return []
    }

    return accounts.filter(account => {
        if (typeof account.email !== 'string') {
            return false
        }

        const username = account.email.split('@')[0]?.toLowerCase()
        return username === normalized || account.email.toLowerCase().startsWith(`${normalized}@`)
    })
}

export function findAccountBySelector(accounts: Account[], selector: string): Account | null {
    const matches = findAccountsBySelector(accounts, selector)
    return matches.length === 1 ? matches[0]! : null
}
