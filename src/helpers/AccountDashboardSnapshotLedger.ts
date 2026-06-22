import fs from 'fs'
import path from 'path'
import type { DashboardInfo } from '../core/InternalPluginAPI'

const STATE_DIR = '.msrb'
const SNAPSHOT_FILE = 'account-dashboard-snapshots.json'

export interface AccountDashboardSnapshot {
    email: string
    updatedAt: string
    level: string | null
    streakDays: number | null
    availablePoints: number | null
    todayPoints: number | null
    dailySetCompleted: number | null
    dailySetTotal: number | null
}

function snapshotPath(cwd = process.cwd()): string {
    return path.join(cwd, STATE_DIR, SNAPSHOT_FILE)
}

function ensureStateDir(cwd = process.cwd()): void {
    fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true })
}

function readStore(cwd = process.cwd()): Record<string, AccountDashboardSnapshot> {
    const file = snapshotPath(cwd)
    if (!fs.existsSync(file)) {
        return {}
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, AccountDashboardSnapshot>
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function writeStore(store: Record<string, AccountDashboardSnapshot>, cwd = process.cwd()): void {
    ensureStateDir(cwd)
    fs.writeFileSync(snapshotPath(cwd), JSON.stringify(store, null, 2), 'utf8')
}

export function dashboardInfoToSnapshot(email: string, info: DashboardInfo): AccountDashboardSnapshot {
    return {
        email: email.toLowerCase(),
        updatedAt: new Date().toISOString(),
        level: info.level,
        streakDays: info.streakDays,
        availablePoints: info.availablePoints,
        todayPoints: info.todayPoints,
        dailySetCompleted: info.dailySetCompleted,
        dailySetTotal: info.dailySetTotal
    }
}

export function saveAccountDashboardSnapshot(email: string, info: DashboardInfo, cwd = process.cwd()): void {
    const store = readStore(cwd)
    store[email.toLowerCase()] = dashboardInfoToSnapshot(email, info)
    writeStore(store, cwd)
}

export function getAccountDashboardSnapshot(email: string, cwd = process.cwd()): AccountDashboardSnapshot | null {
    return readStore(cwd)[email.toLowerCase()] ?? null
}

export function getAccountDashboardSnapshots(cwd = process.cwd()): Record<string, AccountDashboardSnapshot> {
    return readStore(cwd)
}
