export class StaleRewardsSessionError extends Error {
    readonly email: string

    constructor(email: string, message?: string) {
        super(message ?? `Stale Rewards web session for ${email}`)
        this.name = 'StaleRewardsSessionError'
        this.email = email
    }
}

export function isRecoverableRewardsSessionError(error: unknown): boolean {
    if (error instanceof StaleRewardsSessionError) {
        return true
    }

    const message = error instanceof Error ? error.message : String(error)
    return (
        message.includes('Rewards web session could not be established') ||
        message.includes('Rewards web session is not authenticated') ||
        message.includes('Dashboard data not found in HTML') ||
        message.includes('Dashboard data missing from API response') ||
        message.includes('Failed to get dashboard data') ||
        message.includes('HTTP API failed') ||
        message.includes('Stale Rewards web session')
    )
}
