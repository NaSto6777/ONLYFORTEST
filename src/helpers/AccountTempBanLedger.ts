import fs from 'fs'
import path from 'path'

const STATE_DIR = '.msrb'
const TEMP_BANS_DIR = 'temp-bans'

export type AccountSearchIssueKind = 'temp_ban' | 'needs_sign_in' | 'stale_session'

export interface AccountSearchIssueEntry {
    email: string
    kind: AccountSearchIssueKind
    reason: string
    url?: string
    recordedAt: string
}

/** @deprecated use AccountSearchIssueEntry */
export type AccountTempBanEntry = AccountSearchIssueEntry

function todayKey(date = new Date()): string {
    return date.toISOString().slice(0, 10)
}

function bansFilePath(cwd = process.cwd(), date = todayKey()): string {
    return path.join(cwd, STATE_DIR, TEMP_BANS_DIR, `${date}.jsonl`)
}

function ensureBansDir(cwd = process.cwd()): void {
    fs.mkdirSync(path.join(cwd, STATE_DIR, TEMP_BANS_DIR), { recursive: true })
}

function normalizeKind(kind?: string): AccountSearchIssueKind {
    if (kind === 'needs_sign_in') return 'needs_sign_in'
    if (kind === 'stale_session') return 'stale_session'
    return 'temp_ban'
}

export function recordAccountSearchIssue(entry: AccountSearchIssueEntry, cwd = process.cwd()): void {
    ensureBansDir(cwd)
    const line =
        JSON.stringify({
            ...entry,
            kind: normalizeKind(entry.kind),
            email: entry.email.toLowerCase()
        }) + '\n'
    fs.appendFileSync(bansFilePath(cwd), line, 'utf8')
}

/** @deprecated use recordAccountSearchIssue */
export function recordAccountTempBan(entry: AccountSearchIssueEntry, cwd = process.cwd()): void {
    recordAccountSearchIssue({ ...entry, kind: 'temp_ban' }, cwd)
}

export function recordAccountNeedsSignIn(
    entry: Omit<AccountSearchIssueEntry, 'kind'>,
    cwd = process.cwd()
): void {
    recordAccountSearchIssue({ ...entry, kind: 'needs_sign_in' }, cwd)
}

export function recordAccountStaleSession(
    entry: Omit<AccountSearchIssueEntry, 'kind'>,
    cwd = process.cwd()
): void {
    recordAccountSearchIssue({ ...entry, kind: 'stale_session' }, cwd)
}

export function getAccountSearchIssuesToday(cwd = process.cwd()): Map<string, AccountSearchIssueEntry> {
    const file = bansFilePath(cwd)
    const issues = new Map<string, AccountSearchIssueEntry>()

    if (!fs.existsSync(file)) {
        return issues
    }

    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue
        }

        try {
            const entry = JSON.parse(line) as AccountSearchIssueEntry
            if (!entry.email) {
                continue
            }
            const normalized: AccountSearchIssueEntry = {
                ...entry,
                email: entry.email.toLowerCase(),
                kind: normalizeKind(entry.kind)
            }
            issues.set(normalized.email, normalized)
        } catch {
            // Ignore corrupt lines
        }
    }

    return issues
}

/** @deprecated use getAccountSearchIssuesToday */
export function getAccountsTempBannedToday(cwd = process.cwd()): Map<string, AccountSearchIssueEntry> {
    const issues = getAccountSearchIssuesToday(cwd)
    const bans = new Map<string, AccountSearchIssueEntry>()
    for (const [email, entry] of issues) {
        if (entry.kind === 'temp_ban') {
            bans.set(email, entry)
        }
    }
    return bans
}

export function getAccountSearchIssue(email: string, cwd = process.cwd()): AccountSearchIssueEntry | null {
    return getAccountSearchIssuesToday(cwd).get(email.toLowerCase()) ?? null
}

export function isAccountTempBannedToday(email: string, cwd = process.cwd()): boolean {
    const issue = getAccountSearchIssue(email, cwd)
    return issue?.kind === 'temp_ban'
}

export function isAccountNeedsSignInToday(email: string, cwd = process.cwd()): boolean {
    const issue = getAccountSearchIssue(email, cwd)
    return issue?.kind === 'needs_sign_in'
}

export function isAccountStaleSessionToday(email: string, cwd = process.cwd()): boolean {
    const issue = getAccountSearchIssue(email, cwd)
    return issue?.kind === 'stale_session'
}

export function getAccountsWithStaleSessionToday(cwd = process.cwd()): AccountSearchIssueEntry[] {
    return [...getAccountSearchIssuesToday(cwd).values()].filter(entry => entry.kind === 'stale_session')
}

/** Removes only today's stale-session entry; keeps other issue kinds. */
export function clearAccountStaleSession(email: string, cwd = process.cwd()): void {
    const file = bansFilePath(cwd)
    if (!fs.existsSync(file)) {
        return
    }

    const key = email.toLowerCase()
    const kept = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => {
            if (!line.trim()) return false
            try {
                const entry = JSON.parse(line) as AccountSearchIssueEntry
                const entryEmail = entry.email?.toLowerCase()
                if (entryEmail !== key) return true
                return normalizeKind(entry.kind) !== 'stale_session'
            } catch {
                return false
            }
        })

    if (kept.length) {
        fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8')
    } else {
        fs.unlinkSync(file)
    }
}

export function clearAccountSearchIssues(email: string, cwd = process.cwd()): void {
    const file = bansFilePath(cwd)
    if (!fs.existsSync(file)) {
        return
    }

    const key = email.toLowerCase()
    const kept = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => {
            if (!line.trim()) return false
            try {
                const entry = JSON.parse(line) as AccountSearchIssueEntry
                return entry.email?.toLowerCase() !== key
            } catch {
                return false
            }
        })

    if (kept.length) {
        fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8')
    } else {
        fs.unlinkSync(file)
    }
}

/** Removes only today's temp-ban entry; keeps needs_sign_in and other accounts. */
export function clearAccountTempBan(email: string, cwd = process.cwd()): void {
    const file = bansFilePath(cwd)
    if (!fs.existsSync(file)) {
        return
    }

    const key = email.toLowerCase()
    const kept = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => {
            if (!line.trim()) return false
            try {
                const entry = JSON.parse(line) as AccountSearchIssueEntry
                const entryEmail = entry.email?.toLowerCase()
                if (entryEmail !== key) return true
                return normalizeKind(entry.kind) !== 'temp_ban'
            } catch {
                return false
            }
        })

    if (kept.length) {
        fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8')
    } else {
        fs.unlinkSync(file)
    }
}
