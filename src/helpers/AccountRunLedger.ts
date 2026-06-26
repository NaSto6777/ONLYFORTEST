import fs from 'fs'
import path from 'path'

const STATE_DIR = '.msrb'
const RUNS_DIR = 'account-runs'

export interface AccountRunEntry {
    email: string
    success: boolean
    completedAt: string
    collectedPoints?: number
    initialPoints?: number
    finalPoints?: number
    durationSeconds?: number
    level?: string | null
}

export interface AccountRunStats {
    runs: number
    collectedPoints: number
    avgDurationSeconds: number | null
    lastRun: AccountRunEntry | null
}

function todayKey(date = new Date()): string {
    return date.toISOString().slice(0, 10)
}

function runsFilePath(cwd = process.cwd(), date = todayKey()): string {
    return path.join(cwd, STATE_DIR, RUNS_DIR, `${date}.jsonl`)
}

function ensureRunsDir(cwd = process.cwd()): void {
    fs.mkdirSync(path.join(cwd, STATE_DIR, RUNS_DIR), { recursive: true })
}

export function recordAccountRun(entry: AccountRunEntry, cwd = process.cwd()): void {
    ensureRunsDir(cwd)
    const line =
        JSON.stringify({
            ...entry,
            email: entry.email.toLowerCase()
        }) + '\n'
    fs.appendFileSync(runsFilePath(cwd), line, 'utf8')
}

export function getAccountsFinishedToday(cwd = process.cwd()): Set<string> {
    const file = runsFilePath(cwd)
    if (!fs.existsSync(file)) {
        return new Set()
    }

    const finished = new Set<string>()
    const content = fs.readFileSync(file, 'utf8')

    for (const line of content.split('\n')) {
        if (!line.trim()) {
            continue
        }

        try {
            const entry = JSON.parse(line) as AccountRunEntry
            if (entry.success && entry.email) {
                finished.add(entry.email.toLowerCase())
            }
        } catch {
            // Ignore corrupt lines
        }
    }

    return finished
}

export function isAccountFinishedToday(email: string, cwd = process.cwd()): boolean {
    return getAccountsFinishedToday(cwd).has(email.toLowerCase())
}

export function getRunsToday(cwd = process.cwd()): AccountRunEntry[] {
    const file = runsFilePath(cwd)
    if (!fs.existsSync(file)) {
        return []
    }

    const entries: AccountRunEntry[] = []
    const content = fs.readFileSync(file, 'utf8')

    for (const line of content.split('\n')) {
        if (!line.trim()) {
            continue
        }

        try {
            entries.push(JSON.parse(line) as AccountRunEntry)
        } catch {
            // Ignore corrupt lines
        }
    }

    return entries
}

function normalizeEmail(email: string): string {
    return email.toLowerCase()
}

export function getRunsForAccountToday(email: string, cwd = process.cwd()): AccountRunEntry[] {
    const key = normalizeEmail(email)
    return getRunsToday(cwd).filter(run => normalizeEmail(run.email) === key)
}

export function getAccountRunStatsToday(email: string, cwd = process.cwd()): AccountRunStats {
    const runs = getRunsForAccountToday(email, cwd)
    const collectedPoints = runs.reduce((sum, run) => sum + (run.collectedPoints ?? 0), 0)
    const durations = runs.map(run => run.durationSeconds).filter((value): value is number => typeof value === 'number')
    const avgDurationSeconds = durations.length
        ? durations.reduce((sum, value) => sum + value, 0) / durations.length
        : null

    return {
        runs: runs.length,
        collectedPoints,
        avgDurationSeconds,
        lastRun: runs.length ? runs[runs.length - 1] ?? null : null
    }
}
