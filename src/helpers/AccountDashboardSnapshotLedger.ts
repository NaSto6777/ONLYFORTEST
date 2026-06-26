import fs from 'fs'
import path from 'path'
import type { DashboardInfo } from '../core/InternalPluginAPI'
import { compareLevels } from './AccountLevelUtils'

const STATE_DIR = '.msrb'
const SNAPSHOT_FILE = 'account-dashboard-snapshots.json'

export interface AccountLevelChange {
    fromLevel: string
    toLevel: string
    direction: 'up' | 'down'
    changedAt: string
}

export interface AccountDashboardSnapshot {
    email: string
    updatedAt: string
    level: string | null
    levelKey: string | null
    streakDays: number | null
    availablePoints: number | null
    todayPoints: number | null
    dailySetCompleted: number | null
    dailySetTotal: number | null
    lastLevelChange: AccountLevelChange | null
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
        levelKey: info.levelKey,
        streakDays: info.streakDays,
        availablePoints: info.availablePoints,
        todayPoints: info.todayPoints,
        dailySetCompleted: info.dailySetCompleted,
        dailySetTotal: info.dailySetTotal,
        lastLevelChange: null
    }
}

export function saveAccountDashboardSnapshot(email: string, info: DashboardInfo, cwd = process.cwd()): void {
    const store = readStore(cwd)
    const key = email.toLowerCase()
    const previous = store[key] ?? null
    const snapshot = dashboardInfoToSnapshot(email, info)

    const direction = previous
        ? compareLevels(
              { level: previous.level, levelKey: previous.levelKey },
              { level: snapshot.level, levelKey: snapshot.levelKey }
          )
        : null

    if (direction === 'up' || direction === 'down') {
        snapshot.lastLevelChange = {
            fromLevel: previous?.level ?? previous?.levelKey ?? 'Unknown',
            toLevel: snapshot.level ?? snapshot.levelKey ?? 'Unknown',
            direction,
            changedAt: snapshot.updatedAt
        }
    } else {
        snapshot.lastLevelChange = previous?.lastLevelChange ?? null
    }

    store[key] = snapshot
    writeStore(store, cwd)
}

export function getAccountDashboardSnapshot(email: string, cwd = process.cwd()): AccountDashboardSnapshot | null {
    return readStore(cwd)[email.toLowerCase()] ?? null
}

export function getAccountDashboardSnapshots(cwd = process.cwd()): Record<string, AccountDashboardSnapshot> {
    return readStore(cwd)
}
