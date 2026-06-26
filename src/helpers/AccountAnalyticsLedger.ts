import fs from 'fs'
import path from 'path'

import { rankFromLevel } from './AccountLevelUtils'
import { getAccountDashboardSnapshots } from './AccountDashboardSnapshotLedger'
import type { AccountRunEntry } from './AccountRunLedger'
import { loadAccounts } from './ConfigLoader'

const STATE_DIR = '.msrb'
const RUNS_DIR = 'account-runs'
const GOAL_FILE = 'analytics-goal.json'
const DEFAULT_PERIOD_DAYS = 30
const FORECAST_DAYS = 14

export interface AnalyticsGoal {
    pointsTarget: number
    periodDays: number
    label: string
    updatedAt: string
}

export interface AnalyticsDailyPoint {
    date: string
    collected: number
    runs: number
    successfulRuns: number
}

export interface AnalyticsAccountRow {
    email: string
    collected: number
    runs: number
    successfulRuns: number
    availablePoints: number | null
    level: string | null
    levelRank: number | null
    avgPerRun: number
    projectedMonthly: number
    projectedPeriod: number
    sharePercent: number
    goalProgressPercent: number | null
    pointsToGoal: number | null
    daysToGoal: number | null
    onTrackForGoal: boolean | null
    goalReached: boolean | null
}

export interface AnalyticsLevelBucket {
    level: string
    count: number
}

export interface AnalyticsForecastPoint {
    date: string
    actual?: number
    forecast?: number
    cumulativeActual?: number
    cumulativeForecast?: number
}

export interface AnalyticsReport {
    goal: AnalyticsGoal | null
    period: {
        start: string
        end: string
        days: number
        daysWithData: number
    }
    summary: {
        totalCollected: number
        totalAvailablePoints: number
        enabledAccounts: number
        activeAccounts: number
        avgDailyCollected: number
        recentDailyAvg: number
        projectedMonthly: number
        projectedPeriodTotal: number
        goalPerAccount: boolean
        accountsAtGoal: number
        accountsOnTrack: number
        avgPointsToGoal: number | null
        goalProgressPercent: number
        pointsToGoal: number | null
        daysToGoal: number | null
        estimatedGoalDate: string | null
        onTrackForGoal: boolean | null
    }
    daily: AnalyticsDailyPoint[]
    accounts: AnalyticsAccountRow[]
    levels: AnalyticsLevelBucket[]
    forecast: AnalyticsForecastPoint[]
}

function statePath(cwd: string, file: string): string {
    return path.join(cwd, STATE_DIR, file)
}

function runsDir(cwd: string): string {
    return path.join(cwd, STATE_DIR, RUNS_DIR)
}

function dateKey(date: Date): string {
    return date.toISOString().slice(0, 10)
}

function addDays(date: Date, days: number): Date {
    const next = new Date(date)
    next.setUTCDate(next.getUTCDate() + days)
    return next
}

function listDateKeys(start: Date, end: Date): string[] {
    const keys: string[] = []
    const cursor = new Date(start)
    while (cursor <= end) {
        keys.push(dateKey(cursor))
        cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return keys
}

function readGoal(cwd: string): AnalyticsGoal | null {
    const file = statePath(cwd, GOAL_FILE)
    if (!fs.existsSync(file)) {
        return null
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AnalyticsGoal
        if (!parsed || typeof parsed.pointsTarget !== 'number' || parsed.pointsTarget <= 0) {
            return null
        }
        return {
            pointsTarget: Math.round(parsed.pointsTarget),
            periodDays: Math.min(90, Math.max(7, Number(parsed.periodDays) || DEFAULT_PERIOD_DAYS)),
            label: typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.trim() : 'Rewards goal',
            updatedAt: parsed.updatedAt || new Date().toISOString()
        }
    } catch {
        return null
    }
}

export function saveAnalyticsGoal(
    input: { pointsTarget: number; periodDays?: number; label?: string },
    cwd = process.cwd()
): AnalyticsGoal {
    const goal: AnalyticsGoal = {
        pointsTarget: Math.max(1, Math.round(input.pointsTarget)),
        periodDays: Math.min(90, Math.max(7, Math.round(input.periodDays ?? DEFAULT_PERIOD_DAYS))),
        label: input.label?.trim() || 'Rewards goal',
        updatedAt: new Date().toISOString()
    }

    fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true })
    fs.writeFileSync(statePath(cwd, GOAL_FILE), JSON.stringify(goal, null, 2), 'utf8')
    return goal
}

function readRunsForDate(cwd: string, dayKey: string): AccountRunEntry[] {
    const file = path.join(runsDir(cwd), `${dayKey}.jsonl`)
    if (!fs.existsSync(file)) {
        return []
    }

    const entries: AccountRunEntry[] = []
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
            entries.push(JSON.parse(line) as AccountRunEntry)
        } catch {
            // ignore
        }
    }
    return entries
}

function readRunsInRange(cwd: string, start: Date, end: Date): AccountRunEntry[] {
    const entries: AccountRunEntry[] = []
    for (const dayKey of listDateKeys(start, end)) {
        entries.push(...readRunsForDate(cwd, dayKey))
    }
    return entries
}

function buildDailySeries(cwd: string, start: Date, end: Date): AnalyticsDailyPoint[] {
    return listDateKeys(start, end).map(day => {
        const runs = readRunsForDate(cwd, day)
        const successfulRuns = runs.filter(run => run.success)
        return {
            date: day,
            collected: successfulRuns.reduce((sum, run) => sum + (run.collectedPoints ?? 0), 0),
            runs: runs.length,
            successfulRuns: successfulRuns.length
        }
    })
}

function accountGoalMetrics(
    collected: number,
    goalTarget: number,
    periodDays: number,
    daysWithData: number
) {
    const progress = Math.min(100, Math.round((collected / goalTarget) * 1000) / 10)
    const pointsToGoal = Math.max(0, goalTarget - collected)
    const dailyRate = collected / Math.max(daysWithData, 1)
    const projectedPeriod = Math.round(dailyRate * periodDays)
    const daysToGoal = dailyRate > 0 && pointsToGoal > 0 ? Math.ceil(pointsToGoal / dailyRate) : null

    return {
        goalProgressPercent: progress,
        pointsToGoal,
        daysToGoal,
        projectedPeriod,
        onTrackForGoal: projectedPeriod >= goalTarget,
        goalReached: collected >= goalTarget
    }
}

function buildAccountRows(
    runs: AccountRunEntry[],
    periodDays: number,
    daysWithData: number,
    goalTarget: number | null
): AnalyticsAccountRow[] {
    const snapshots = getAccountDashboardSnapshots()
    const byEmail = new Map<string, { collected: number; runs: number; successfulRuns: number }>()

    for (const run of runs) {
        const key = run.email.toLowerCase()
        const bucket = byEmail.get(key) ?? { collected: 0, runs: 0, successfulRuns: 0 }
        bucket.runs += 1
        if (run.success) {
            bucket.successfulRuns += 1
            bucket.collected += run.collectedPoints ?? 0
        }
        byEmail.set(key, bucket)
    }

    for (const account of loadAccounts().filter(entry => entry.enabled !== false)) {
        const key = account.email.toLowerCase()
        if (!byEmail.has(key)) {
            byEmail.set(key, { collected: 0, runs: 0, successfulRuns: 0 })
        }
    }

    const totalCollected = [...byEmail.values()].reduce((sum, row) => sum + row.collected, 0)
    const effectiveDays = Math.max(daysWithData, 1)

    const rows: AnalyticsAccountRow[] = [...byEmail.entries()].map(([email, stats]) => {
        const snapshot = snapshots[email]
        const avgPerRun = stats.successfulRuns ? stats.collected / stats.successfulRuns : 0
        const dailyAvg = stats.collected / effectiveDays
        const goalMetrics = goalTarget
            ? accountGoalMetrics(stats.collected, goalTarget, periodDays, daysWithData)
            : null

        return {
            email,
            collected: stats.collected,
            runs: stats.runs,
            successfulRuns: stats.successfulRuns,
            availablePoints: snapshot?.availablePoints ?? null,
            level: snapshot?.level ?? null,
            levelRank: rankFromLevel(snapshot?.levelKey ?? snapshot?.level ?? null),
            avgPerRun: Math.round(avgPerRun),
            projectedMonthly: Math.round(dailyAvg * 30),
            projectedPeriod: goalMetrics?.projectedPeriod ?? Math.round(dailyAvg * periodDays),
            sharePercent: totalCollected > 0 ? Math.round((stats.collected / totalCollected) * 1000) / 10 : 0,
            goalProgressPercent: goalMetrics?.goalProgressPercent ?? null,
            pointsToGoal: goalMetrics?.pointsToGoal ?? null,
            daysToGoal: goalMetrics?.daysToGoal ?? null,
            onTrackForGoal: goalMetrics?.onTrackForGoal ?? null,
            goalReached: goalMetrics?.goalReached ?? null
        }
    })

    return rows.sort((a, b) => b.collected - a.collected)
}

function buildLevelBuckets(): AnalyticsLevelBucket[] {
    const snapshots = getAccountDashboardSnapshots()
    const counts = new Map<string, number>()

    for (const account of loadAccounts().filter(entry => entry.enabled !== false)) {
        const snapshot = snapshots[account.email.toLowerCase()]
        const label = snapshot?.level || 'Unknown'
        counts.set(label, (counts.get(label) ?? 0) + 1)
    }

    return [...counts.entries()]
        .map(([level, count]) => ({ level, count }))
        .sort((a, b) => {
            const rankA = rankFromLevel(a.level) ?? 0
            const rankB = rankFromLevel(b.level) ?? 0
            return rankB - rankA || b.count - a.count
        })
}

function buildForecast(daily: AnalyticsDailyPoint[], recentDailyAvg: number): AnalyticsForecastPoint[] {
    const points: AnalyticsForecastPoint[] = []
    let cumulativeActual = 0
    let cumulativeForecast = 0

    for (const day of daily) {
        cumulativeActual += day.collected
        points.push({
            date: day.date,
            actual: day.collected,
            cumulativeActual
        })
    }

    const lastDate = daily.length ? new Date(`${daily[daily.length - 1]!.date}T00:00:00.000Z`) : new Date()
    cumulativeForecast = cumulativeActual

    for (let i = 1; i <= FORECAST_DAYS; i++) {
        const next = addDays(lastDate, i)
        cumulativeForecast += recentDailyAvg
        points.push({
            date: dateKey(next),
            forecast: Math.round(recentDailyAvg),
            cumulativeForecast: Math.round(cumulativeForecast)
        })
    }

    return points
}

export function buildAnalyticsReport(cwd = process.cwd()): AnalyticsReport {
    const goal = readGoal(cwd)
    const periodDays = goal?.periodDays ?? DEFAULT_PERIOD_DAYS
    const end = new Date()
    const start = addDays(end, -(periodDays - 1))
    const daily = buildDailySeries(cwd, start, end)
    const runs = readRunsInRange(cwd, start, end)
    const daysWithData = daily.filter(day => day.collected > 0 || day.runs > 0).length
    const totalCollected = daily.reduce((sum, day) => sum + day.collected, 0)
    const avgDailyCollected = totalCollected / Math.max(periodDays, 1)

    const recentWindow = daily.slice(-7)
    const recentDaysWithData = recentWindow.filter(day => day.collected > 0).length
    const recentCollected = recentWindow.reduce((sum, day) => sum + day.collected, 0)
    const recentDailyAvg =
        recentDaysWithData > 0 ? recentCollected / recentDaysWithData : avgDailyCollected

    const accounts = buildAccountRows(runs, periodDays, Math.max(daysWithData, 1), goal?.pointsTarget ?? null)
    const snapshots = getAccountDashboardSnapshots()
    const enabledAccounts = loadAccounts().filter(account => account.enabled !== false)
    const totalAvailablePoints = enabledAccounts.reduce((sum, account) => {
        const snapshot = snapshots[account.email.toLowerCase()]
        return sum + (snapshot?.availablePoints ?? 0)
    }, 0)

    const projectedMonthly = Math.round(recentDailyAvg * 30)
    const projectedPeriodTotal = Math.round(recentDailyAvg * periodDays)

    const accountsAtGoal = goal ? accounts.filter(account => account.goalReached).length : 0
    const accountsOnTrack = goal ? accounts.filter(account => account.onTrackForGoal).length : 0
    const laggingAccounts = goal ? accounts.filter(account => !account.goalReached) : []
    const avgGoalProgressPercent = goal && accounts.length
        ? Math.round(
              (accounts.reduce((sum, account) => sum + (account.goalProgressPercent ?? 0), 0) / accounts.length) *
                  10
          ) / 10
        : 0
    const avgPointsToGoal =
        goal && laggingAccounts.length
            ? Math.round(
                  laggingAccounts.reduce((sum, account) => sum + (account.pointsToGoal ?? 0), 0) /
                      laggingAccounts.length
              )
            : goal
              ? 0
              : null
    const daysToGoalValues = laggingAccounts
        .map(account => account.daysToGoal)
        .filter((value): value is number => value !== null)
    const daysToGoal =
        goal && daysToGoalValues.length
            ? Math.ceil(daysToGoalValues.reduce((sum, value) => sum + value, 0) / daysToGoalValues.length)
            : null
    const estimatedGoalDate =
        daysToGoal !== null ? dateKey(addDays(new Date(), daysToGoal)) : null
    const goalProgressPercent = avgGoalProgressPercent
    const pointsToGoal = avgPointsToGoal

    return {
        goal,
        period: {
            start: dateKey(start),
            end: dateKey(end),
            days: periodDays,
            daysWithData
        },
        summary: {
            totalCollected,
            totalAvailablePoints,
            enabledAccounts: enabledAccounts.length,
            activeAccounts: accounts.filter(account => account.runs > 0).length,
            avgDailyCollected: Math.round(avgDailyCollected),
            recentDailyAvg: Math.round(recentDailyAvg),
            projectedMonthly,
            projectedPeriodTotal,
            goalPerAccount: !!goal,
            accountsAtGoal,
            accountsOnTrack,
            avgPointsToGoal,
            goalProgressPercent,
            pointsToGoal,
            daysToGoal,
            estimatedGoalDate,
            onTrackForGoal: goal
                ? accountsAtGoal === accounts.length || accountsOnTrack >= Math.ceil(accounts.length * 0.75)
                : null
        },
        daily,
        accounts,
        levels: buildLevelBuckets(),
        forecast: buildForecast(daily, recentDailyAvg)
    }
}
