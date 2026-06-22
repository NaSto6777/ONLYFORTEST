import { getCurrentContext } from '../context/ExecutionContext'
import { isRecoverableRewardsSessionError } from '../errors/RewardsSessionErrors'
import { recordAccountStaleSession } from './AccountTempBanLedger'

export function maybeRecordStaleSession(email: string | undefined, error: unknown, cwd = process.cwd()): void {
    const accountEmail = (email || getCurrentContext().account?.email || '').trim().toLowerCase()
    if (!accountEmail || accountEmail === 'unknown') {
        return
    }

    if (!isRecoverableRewardsSessionError(error)) {
        return
    }

    const reason = error instanceof Error ? error.message : String(error)
    recordAccountStaleSession(
        {
            email: accountEmail,
            reason,
            recordedAt: new Date().toISOString()
        },
        cwd
    )
}
