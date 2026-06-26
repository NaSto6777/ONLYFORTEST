export type LevelDirection = 'up' | 'down' | 'same'

export interface LevelSnapshot {
    level: string | null
    levelKey: string | null
}

export function rankFromLevel(value: string | null | undefined): number | null {
    if (!value) {
        return null
    }

    const trimmed = value.trim()
    if (!trimmed) {
        return null
    }

    const numeric = trimmed.match(/(\d+)/)
    if (numeric) {
        return Number.parseInt(numeric[1] ?? '', 10)
    }

    const lower = trimmed.toLowerCase()
    const named: Record<string, number> = {
        bronze: 1,
        silver: 2,
        gold: 3
    }

    for (const [name, rank] of Object.entries(named)) {
        if (lower.includes(name)) {
            return rank
        }
    }

    return null
}

export function compareLevels(previous: LevelSnapshot, next: LevelSnapshot): LevelDirection | null {
    const prevRank = rankFromLevel(previous.levelKey ?? previous.level)
    const nextRank = rankFromLevel(next.levelKey ?? next.level)

    if (prevRank === null || nextRank === null) {
        return null
    }

    if (nextRank > prevRank) {
        return 'up'
    }

    if (nextRank < prevRank) {
        return 'down'
    }

    return 'same'
}
