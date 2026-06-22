export type ClusterWorkerPhase =
    | 'idle'
    | 'starting'
    | 'login'
    | 'dashboard'
    | 'claim'
    | 'promotions'
    | 'searches'
    | 'finishing'

export interface ClusterWorkerStatus {
    workerId: number
    pid: number
    account: string | null
    phase: ClusterWorkerPhase
    completedCount: number
    updatedAt: string
}

export interface ClusterRunProgress {
    totalAccounts: number
    completedAccounts: number
    queuedAccounts: number
    activeWorkers: number
    configuredWorkers: number
}
