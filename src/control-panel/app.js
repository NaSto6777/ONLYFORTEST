(function () {
    'use strict'

    const params = new URLSearchParams(window.location.search)
    const token = params.get('token') || sessionStorage.getItem('msrb-panel-token') || ''
    if (token) sessionStorage.setItem('msrb-panel-token', token)

    const logs = []
    let configCache = null
    let accountsCache = []
    let logEventSource = null
    let logPaused = false
    let dashboardInfoEnabled = false
    const runModalSelected = new Set()
    let activePasswordlessPrompt = null
    let passwordlessCountdownTimer = null

    const WORKER_GROUPS = {
        promo: ['doDailySet', 'doSpecialPromotions', 'doMorePromotions', 'doAppPromotions', 'doClaimPoints', 'doDashboardInfo'],
        search: ['doDesktopSearch', 'doMobileSearch', 'doReadToEarn', 'doDailyStreak', 'enforceCoreStreakProtectionGate'],
        other: ['doDailyCheckIn', 'doRedeemGoal']
    }

    const WORKER_LABELS = {
        doDailySet: 'Daily Set',
        doSpecialPromotions: 'Special Promotions',
        doMorePromotions: 'More Promotions',
        doAppPromotions: 'App Promotions',
        doDesktopSearch: 'Desktop Search',
        doMobileSearch: 'Mobile Search',
        doDailyCheckIn: 'Daily Check-In',
        doReadToEarn: 'Read to Earn',
        doDailyStreak: 'Daily Streak',
        doRedeemGoal: 'Redeem Goal',
        doDashboardInfo: 'Dashboard Info',
        doClaimPoints: 'Claim Points',
        enforceCoreStreakProtectionGate: 'Streak Protection'
    }

    const WORKER_HINTS = {
        doDailySet: 'Complete today\'s daily set activities',
        doSpecialPromotions: 'Limited-time bonus promotions',
        doMorePromotions: 'Extra point offers on the dashboard',
        doAppPromotions: 'Mobile app promotion tasks',
        doDesktopSearch: 'Bing desktop search points',
        doMobileSearch: 'Bing mobile search points',
        doDailyCheckIn: 'Daily app check-in bonus',
        doReadToEarn: 'Read articles for bonus points',
        doDailyStreak: 'Maintain daily streak counters',
        doRedeemGoal: 'Track redeem goal progress',
        doDashboardInfo: 'Fetch dashboard stats each run',
        doClaimPoints: 'Auto-claim available points',
        enforceCoreStreakProtectionGate: 'Always enable streak protection'
    }

    const STATUS_LABELS = {
        idle: 'Ready',
        waiting: 'Ready',
        checking: 'Starting…',
        running: 'Running',
        finished: 'Finished',
        blocked: 'Blocked',
        error: 'Error'
    }

    const WORKER_PHASE_LABELS = {
        idle: 'Waiting',
        starting: 'Starting',
        login: 'Sign in',
        dashboard: 'Dashboard',
        claim: 'Claim points',
        promotions: 'Promotions',
        searches: 'Searches',
        finishing: 'Finishing'
    }

    function $(id) { return document.getElementById(id) }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    function maskEmail(email) {
        const at = email.indexOf('@')
        if (at <= 0) return email
        const user = email.slice(0, at)
        const domain = email.slice(at)
        const visible = user.slice(0, Math.min(2, user.length))
        return visible + '*****' + domain
    }

    function initials(email) {
        const user = email.split('@')[0] || '?'
        return user.slice(0, 2).toUpperCase()
    }

    function delayToSeconds(value) {
        if (value === null || value === undefined || value === '') return ''
        if (typeof value === 'number') return value >= 1000 ? Math.round(value / 1000) : value
        const raw = String(value).trim().toLowerCase()
        const num = parseFloat(raw)
        if (Number.isNaN(num)) return ''
        if (raw.includes('min')) return Math.round(num * 60)
        if (raw.includes('ms')) return Math.round(num / 1000)
        if (raw.includes('sec') || /\d\s*s$/.test(raw)) return Math.round(num)
        return num >= 1000 ? Math.round(num / 1000) : Math.round(num)
    }

    function secondsToDelaySec(seconds) {
        const n = Number(seconds)
        if (!Number.isFinite(n) || n < 0) return '0sec'
        return Math.round(n) + 'sec'
    }

    function showToast(message, type) {
        const el = $('toast')
        el.textContent = message
        el.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '')
        clearTimeout(showToast._timer)
        showToast._timer = setTimeout(() => el.classList.add('hidden'), 4000)
    }

    function setConnected(ok) {
        const dot = $('conn-dot')
        const label = $('conn-label')
        if (dot) dot.className = 'footer-dot' + (ok ? '' : ' error')
        if (label) label.textContent = ok ? 'Bot ready' : 'Disconnected'
    }

    async function api(path, options = {}) {
        const headers = { ...(options.headers || {}), Authorization: 'Bearer ' + token }
        if (options.body) headers['Content-Type'] = 'application/json'
        const res = await fetch(path, { ...options, headers })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || res.statusText)
        setConnected(true)
        return data
    }

    function formatUptime(ms) {
        const s = Math.floor(ms / 1000)
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        const sec = s % 60
        if (h) return h + 'h ' + m + 'm'
        if (m) return m + 'm ' + sec + 's'
        return sec + 's'
    }

    function switchTab(tab) {
        document.querySelectorAll('.nav-item').forEach(t => t.classList.toggle('active', t.dataset.tab === tab))
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
        const panel = $('tab-' + tab)
        if (panel) panel.classList.add('active')
    }

    function switchSettingsPane(pane) {
        document.querySelectorAll('.settings-nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.settings === pane)
        })
        document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'))
        const target = $('settings-' + pane)
        if (target) target.classList.add('active')
        const savebar = $('settings-savebar')
        if (savebar) savebar.hidden = pane === 'workers'
    }

    function clampClusters(n) {
        return Math.min(16, Math.max(1, Number(n) || 1))
    }

    function setQuickClusters(n) {
        const val = clampClusters(n)
        if ($('quick-clusters')) $('quick-clusters').value = val
        if ($('quick-clusters-val')) $('quick-clusters-val').textContent = val
    }

    function setCfgClusters(n) {
        const val = clampClusters(n)
        if ($('cfg-clusters')) $('cfg-clusters').value = val
    }

    function paintSettingsSummary(config, status) {
        const el = $('settings-summary')
        if (!el) return
        const cfg = config || configCache
        if (!cfg) {
            el.textContent = 'Loading…'
            return
        }
        const clusters = status?.clusters ?? cfg.clusters ?? 3
        const headless = status?.headless ?? cfg.headless
        const sched = cfg.scheduler || {}
        let text = clusters + ' cluster' + (clusters === 1 ? '' : 's') + ' · ' + (headless ? 'headless' : 'visible')
        if (sched.enabled) {
            text += ' · scheduler ' + (sched.startTime || '08:00')
        } else {
            text += ' · scheduler off'
        }
        el.textContent = text

        const hint = $('scheduler-next-hint')
        if (hint) {
            if (status?.schedulerEnabled && status?.nextScheduledRun) {
                hint.textContent = 'Next scheduled run: ' + status.nextScheduledRun
                hint.hidden = false
            } else if (sched.enabled) {
                hint.textContent = 'Scheduler enabled — save settings to apply timezone and start time.'
                hint.hidden = false
            } else {
                hint.textContent = 'Scheduler is off. Enable it to run automatically each day.'
                hint.hidden = false
            }
        }
    }

    function updateHeadlessLabel(checked, labelId) {
        const label = $(labelId || 'headless-label')
        if (label) label.textContent = checked ? 'Headless mode' : 'Visible browsers'
    }

    function updateModeBadge(clusters, headless) {
        const badge = $('dash-mode-badge')
        if (!badge) return
        badge.textContent = clusters + ' cluster' + (clusters === 1 ? '' : 's') + ' · ' + (headless ? 'headless' : 'visible')
    }

    function syncDashControls(clusters, headless) {
        if ($('dash-headless')) $('dash-headless').checked = !!headless
        if ($('dash-clusters-control')) $('dash-clusters-control').textContent = clusters
        updateHeadlessLabel(!!headless)
        updateModeBadge(clusters, !!headless)
    }

    function setProgressRing(finished, enabled) {
        const arc = $('dash-progress-arc')
        if (!arc) return
        const total = Math.max(1, enabled || 1)
        const pct = Math.min(1, (finished || 0) / total)
        const circumference = 327
        arc.style.strokeDashoffset = String(circumference * (1 - pct))
    }

    function setRunState(state) {
        const running = state === 'running' || state === 'checking'
        const label = STATUS_LABELS[state] || state
        const hint = running
            ? 'Bot is farming accounts…'
            : state === 'finished'
            ? 'Last run completed.'
            : state === 'error' || state === 'blocked'
            ? 'Check Console for details.'
            : 'Click "Run now" to start farming.'

        if ($('btn-run')) $('btn-run').disabled = running
        if ($('btn-dash-run')) $('btn-dash-run').disabled = running
        if ($('dash-bot-status')) $('dash-bot-status').textContent = label
        if ($('dash-bot-hint')) $('dash-bot-hint').textContent = hint

        const statusCard = $('dash-status-card')
        if (statusCard) {
            const stateClass = running
                ? 'state-running'
                : state === 'error' || state === 'blocked'
                ? 'state-error'
                : state === 'finished'
                ? 'state-finished'
                : 'state-ready'
            statusCard.className = 'desk-card dash-status-card ' + stateClass
        }

        const sidebar = $('sidebar-status')
        const sidebarText = $('sidebar-status-text')
        const sidebarDot = sidebar?.querySelector('.status-dot')
        const ring = $('status-ring')
        const dotClass = running ? ' running' : state === 'error' || state === 'blocked' ? ' error' : ''

        if (sidebar) sidebar.className = 'sidebar-status' + dotClass
        if (sidebarDot) sidebarDot.className = 'status-dot' + dotClass
        if (sidebarText) sidebarText.textContent = label
        if (ring) ring.className = 'status-ring' + (running ? ' running' : '')

        const dot = $('conn-dot')
        if (dot) dot.className = 'footer-dot' + dotClass
        if ($('conn-label')) $('conn-label').textContent = running ? 'Bot running' : label === 'Ready' ? 'Bot ready' : label
        updateDashboardRunButtons(running)
        document.querySelectorAll('.icon-btn.run, .icon-btn.open, .icon-btn.open-mobile').forEach(btn => { btn.disabled = running })
    }

    function formatDuration(seconds) {
        if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return ''
        const total = Math.max(0, Math.round(Number(seconds)))
        if (total < 60) return total + 's'
        const mins = Math.floor(total / 60)
        const secs = total % 60
        return secs ? mins + 'm ' + secs + 's' : mins + 'm'
    }

    function formatPoints(value) {
        if (value === null || value === undefined) return '—'
        return Number(value).toLocaleString()
    }

    function formatLevelChangeHtml(change) {
        if (!change) return ''
        const arrow = change.direction === 'up' ? '↑' : '↓'
        const cls = change.direction === 'up' ? 'level-up' : 'level-down'
        const title = change.direction === 'up' ? 'Level upgraded' : 'Level downgraded'
        return (
            '<span class="acc-insight-pill ' + cls + '" title="' + escapeHtml(title) + '">' +
            arrow + ' ' + escapeHtml(change.fromLevel) + ' → ' + escapeHtml(change.toLevel) +
            '</span>'
        )
    }

    function formatDashboardStatsHtml(stats) {
        if (!stats || !dashboardInfoEnabled) return ''

        const pills = []
        if (stats.availablePoints !== null && stats.availablePoints !== undefined) {
            pills.push(
                '<span class="acc-insight-pill points" title="Available Rewards points">' +
                formatPoints(stats.availablePoints) + ' pts</span>'
            )
        }
        if (stats.todayPoints !== null && stats.todayPoints !== undefined && stats.todayPoints > 0) {
            pills.push(
                '<span class="acc-insight-pill today-points" title="Points earned today on Rewards">' +
                '+' + formatPoints(stats.todayPoints) + ' today</span>'
            )
        }
        if (stats.streakDays !== null && stats.streakDays !== undefined) {
            pills.push('<span class="acc-insight-pill streak" title="Daily streak">' + stats.streakDays + 'd streak</span>')
        }
        if (stats.level) {
            pills.push('<span class="acc-insight-pill rank" title="Rewards level">' + escapeHtml(String(stats.level)) + '</span>')
        }
        pills.push(formatLevelChangeHtml(stats.lastLevelChange))
        if (stats.dailySetTotal !== null && stats.dailySetTotal !== undefined) {
            const done = stats.dailySetCompleted ?? 0
            const total = stats.dailySetTotal
            const partial = done < total
            pills.push(
                '<span class="acc-insight-pill daily-set' + (partial ? ' partial' : ' complete') + '" title="Daily set progress">' +
                'Daily ' + done + '/' + total +
                '</span>'
            )
        }

        if (!pills.filter(Boolean).length) return ''
        return '<div class="acc-preview-stats">' + pills.filter(Boolean).join('') + '</div>'
    }

    function formatRunStatsHtml(runStats) {
        if (!runStats) return ''
        const parts = []
        if (runStats.collectedToday > 0) {
            parts.push('+' + formatPoints(runStats.collectedToday) + ' farmed today')
        }
        if (runStats.lastRun?.durationSeconds) {
            parts.push(formatDuration(runStats.lastRun.durationSeconds) + ' last run')
        } else if (runStats.avgDurationSeconds) {
            parts.push(formatDuration(runStats.avgDurationSeconds) + ' avg')
        }
        if (runStats.runsToday > 1) {
            parts.push(runStats.runsToday + ' runs today')
        }
        if (!parts.length) return ''
        return '<div class="acc-run-stats">' + parts.map(p => '<span>' + escapeHtml(p) + '</span>').join('') + '</div>'
    }

    function dashboardStatsForEmail(email) {
        const account = accountsCache.find(a => a.email.toLowerCase() === email.toLowerCase())
        return account?.dashboardStats ?? null
    }

    function paintWorkers(status) {
        const list = $('dash-workers-list')
        const summary = $('dash-workers-summary')
        const card = $('dash-workers-card')
        if (!list || !summary) return

        const workers = status?.clusterWorkers || []
        const progress = status?.runProgress
        const running = status?.runState === 'running' || status?.runState === 'checking'
        const configured = status?.clusters ?? progress?.configuredWorkers ?? workers.length

        if (progress && running) {
            const farming = workers.filter(w => w.account).length
            const idleWorkers = workers.filter(w => !w.account).length
            summary.textContent =
                farming + ' farming' +
                (idleWorkers ? ' · ' + idleWorkers + ' waiting' : '') +
                ' · ' + progress.completedAccounts + '/' + progress.totalAccounts + ' done · ' +
                progress.queuedAccounts + ' queued'
        } else if (configured > 1) {
            summary.textContent = configured + ' workers configured · idle until next run'
        } else {
            summary.textContent = 'Single worker mode'
        }

        if (card) {
            card.hidden = !running && workers.length === 0 && configured <= 1
        }

        if (!workers.length) {
            list.innerHTML = '<div class="workers-live-empty">' +
                (running ? 'Workers starting…' : 'Worker status appears here during a run.') +
                '</div>'
            return
        }

        list.innerHTML = workers.map(w => {
            const phaseLabel = WORKER_PHASE_LABELS[w.phase] || w.phase
            const active = w.phase !== 'idle' && w.account
            const email = w.account ? maskEmail(w.account) : '—'
            return (
                '<div class="worker-live-card' + (active ? ' active' : ' idle') + '">' +
                '<div class="worker-live-head">' +
                '<span class="worker-live-title">Worker ' + w.workerId + '</span>' +
                '<span class="worker-live-phase' + (w.phase === 'idle' ? ' idle' : '') + '">' + escapeHtml(phaseLabel) + '</span>' +
                '</div>' +
                '<div class="worker-live-email">' + escapeHtml(email) + '</div>' +
                '<div class="worker-live-meta">Completed this run: ' + (w.completedCount ?? 0) + '</div>' +
                '</div>'
            )
        }).join('')
    }

    function paintStaleSessionAlert(staleEmails) {
        const alert = $('dash-session-alert')
        const list = $('dash-session-alert-list')
        const title = $('dash-session-alert-title')
        if (!alert || !list) return

        const emails = Array.isArray(staleEmails)
            ? staleEmails
            : accountsCache.filter(a => a.searchIssue === 'stale_session').map(a => a.email)

        if (!emails.length) {
            alert.classList.add('hidden')
            list.innerHTML = ''
            return
        }

        alert.classList.remove('hidden')
        if (title) {
            title.textContent = emails.length === 1
                ? '1 account needs session cleared'
                : emails.length + ' accounts need session cleared'
        }
        list.innerHTML = emails.map(email => '<li>' + escapeHtml(email) + '</li>').join('')
    }

    function paintDashboardAccounts() {
        const container = $('dash-accounts-preview')
        if (!container) return

        const enabled = accountsCache.filter(a => a.enabled)
        const pending = enabled.filter(a => !a.finishedToday)
        const stale = enabled.filter(a => a.searchIssue === 'stale_session')
        const countEl = $('dash-accounts-count')
        if (countEl) {
            let text = enabled.length + ' enabled · ' + pending.length + ' pending'
            if (stale.length) text += ' · ' + stale.length + ' need session cleared'
            countEl.textContent = text
        }

        const previewSource = stale.length ? stale : (pending.length ? pending : enabled)
        const maxShow = 12
        const slice = previewSource.slice(0, maxShow)
        const rest = previewSource.length - slice.length

        if (!slice.length) {
            container.innerHTML = '<p class="points-empty">No enabled accounts.</p>'
            return
        }

        const running = $('btn-run')?.disabled
        container.innerHTML = slice.map(a => {
            const state = a.searchIssue === 'stale_session'
                ? 'Clear session'
                : a.finishedToday
                ? 'Done today'
                : 'Ready'
            const dotClass = a.searchIssue === 'stale_session'
                ? 'stale'
                : a.finishedToday
                ? 'done'
                : ''
            const avatar = accountAvatarColor(a.email)
            const statsHtml = formatDashboardStatsHtml(a.dashboardStats) + formatRunStatsHtml(a.runStats)
            return (
                '<div class="acc-preview" data-email="' + escapeHtml(a.email) + '">' +
                '<div class="acc-avatar" style="background:' + avatar.bg + ';color:' + avatar.fg + '">' + escapeHtml(initials(a.email)) + '</div>' +
                '<div class="acc-preview-info">' +
                '<div class="email">' + escapeHtml(maskEmail(a.email)) + '</div>' +
                '<div class="state"><span class="state-dot ' + dotClass + '"></span>' + state + '</div>' +
                statsHtml +
                '</div>' +
                '<button type="button" class="acc-run-btn" title="Run this account"' + (running ? ' disabled' : '') + '>' +
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
                '</button></div>'
            )
        }).join('') +
            (rest > 0 ? '<div class="acc-preview-more" data-goto="accounts">+' + rest + ' more accounts →</div>' : '')

        container.querySelectorAll('.acc-run-btn').forEach(btn => {
            btn.addEventListener('click', ev => {
                ev.stopPropagation()
                const row = btn.closest('.acc-preview')
                const email = row?.dataset.email
                if (!email) return
                openRunModal({ focusEmail: email })
            })
        })
        container.querySelectorAll('.acc-preview-more[data-goto]').forEach(el => {
            el.addEventListener('click', () => switchTab(el.dataset.goto))
        })
    }

    async function refreshStatus() {
        const data = await api('/api/status')
        dashboardInfoEnabled = data.dashboardInfoEnabled === true
        setRunState(data.runState)

        if ($('dash-version')) $('dash-version').textContent = data.version
        const uptime = formatUptime(data.uptimeMs)
        if ($('dash-uptime')) $('dash-uptime').textContent = uptime
        if ($('dash-stat-uptime')) $('dash-stat-uptime').textContent = uptime
        if ($('dash-pending')) $('dash-pending').textContent = data.pendingAccounts
        if ($('dash-finished')) $('dash-finished').textContent = data.finishedToday ?? 0
        if ($('dash-enabled')) $('dash-enabled').textContent = data.enabledAccounts ?? 0
        if ($('dash-stat-pending')) $('dash-stat-pending').textContent = data.pendingAccounts
        if ($('dash-stat-done')) $('dash-stat-done').textContent = data.finishedToday ?? 0
        if ($('nav-pending')) $('nav-pending').textContent = data.pendingAccounts

        const points = data.pointsToday ?? 0
        const finished = data.finishedToday ?? 0
        const pending = data.pendingAccounts ?? 0
        const enabled = data.enabledAccounts ?? 0

        if ($('dash-stat-points')) {
            $('dash-stat-points').textContent = '+' + points.toLocaleString()
            $('dash-stat-points').className = 'dash-stat-value' + (points > 0 ? ' success' : '')
        }

        const schedPill = $('dash-sched-pill')
        if (schedPill) {
            if (data.schedulerEnabled && data.nextScheduledRun) {
                schedPill.textContent = 'Next: ' + data.nextScheduledRun
                schedPill.hidden = false
            } else if (data.schedulerEnabled) {
                schedPill.textContent = 'Scheduler on'
                schedPill.hidden = false
            } else {
                schedPill.hidden = true
            }
        }

        setProgressRing(finished, enabled)

        const countEl = $('dash-accounts-count')
        if (countEl && data.enabledAccounts !== undefined) {
            countEl.textContent = data.enabledAccounts + ' enabled · ' + pending + ' pending'
        }

        const hasPoints = points > 0
        const hasQueue = pending > 0
        const hasActivity = hasPoints || finished > 0

        if ($('points-empty')) {
            if (!hasActivity && !hasQueue) {
                $('points-empty').textContent = 'No runs yet'
            } else if (!hasActivity && hasQueue) {
                $('points-empty').textContent = pending + ' ready'
            } else {
                $('points-empty').textContent = finished + '/' + enabled + ' done'
            }
        }
        if ($('dash-points')) {
            if (hasPoints) {
                $('dash-points').hidden = false
                $('dash-points').textContent = '+' + points.toLocaleString()
            } else {
                $('dash-points').hidden = true
                $('dash-points').textContent = '+0'
            }
        }
        if ($('points-subline')) {
            if (hasActivity) {
                $('points-subline').textContent = finished + ' accounts completed · ' + pending + ' remaining'
                $('points-subline').hidden = false
            } else if (hasQueue) {
                $('points-subline').textContent = (data.clusters ?? 3) + ' clusters · ' + (data.headless ? 'headless' : 'visible')
                $('points-subline').hidden = false
            } else {
                $('points-subline').hidden = true
            }
        }

        syncDashControls(data.clusters, data.headless)
        if ($('quick-headless')) $('quick-headless').checked = !!data.headless
        updateHeadlessLabel(!!data.headless, 'quick-headless-label')
        if ($('quick-clusters')) {
            setQuickClusters(data.clusters)
        }
        if ($('quick-panel-startup')) {
            $('quick-panel-startup').checked = data.controlPanelRunOnStartup !== false
        }
        paintSettingsSummary(configCache, data)
        const insightsHint = $('dash-insights-hint')
        if (insightsHint) insightsHint.hidden = !dashboardInfoEnabled
        paintWorkers(data)
        paintStaleSessionAlert(data.staleSessionAccounts || [])
        if (accountsCache.length) paintDashboardAccounts()
    }

    function updateDashboardRunButtons(running) {
        document.querySelectorAll('.acc-run-btn').forEach(btn => { btn.disabled = running })
    }

    async function refreshRunsToday() {
        const container = $('runs-today')
        if (!container) return
        const data = await api('/api/runs/today')
        if (!data.runs || !data.runs.length) {
            container.innerHTML = '<div class="runs-empty">No completed runs today.</div>'
            return
        }
        container.innerHTML = data.runs.map(r => {
            const avatar = accountAvatarColor(r.email)
            const pts = r.collectedPoints ?? 0
            const duration = r.durationSeconds ? formatDuration(r.durationSeconds) : ''
            const statsHtml = formatDashboardStatsHtml(dashboardStatsForEmail(r.email))
            const metaParts = [r.success ? 'Completed successfully' : 'Run failed']
            if (duration) metaParts.push(duration)
            if (r.level) metaParts.push(r.level)
            return (
                '<div class="run-row">' +
                '<div class="run-row-avatar" style="background:' + avatar.bg + ';color:' + avatar.fg + '">' +
                escapeHtml(initials(r.email)) + '</div>' +
                '<div class="run-row-info">' +
                '<div class="run-row-email">' + escapeHtml(maskEmail(r.email)) + '</div>' +
                '<div class="run-row-meta">' + escapeHtml(metaParts.join(' · ')) + '</div>' +
                statsHtml +
                '</div>' +
                '<div class="run-row-points' + (r.success ? '' : ' fail') + '">' +
                (r.success ? '+' + pts : 'Failed') +
                '</div></div>'
            )
        }).join('')
    }

    function accountAvatarColor(email) {
        let hash = 0
        for (let i = 0; i < email.length; i++) hash = email.charCodeAt(i) + ((hash << 5) - hash)
        const hues = [210, 250, 190, 330, 280, 160]
        const hue = hues[Math.abs(hash) % hues.length]
        return {
            bg: 'hsla(' + hue + ', 55%, 45%, 0.18)',
            fg: 'hsl(' + hue + ', 75%, 72%)'
        }
    }

    const ICONS = {
        open: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
        mobile: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
        run: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        clear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
        close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>'
    }

    function paintAccountsSummary() {
        const el = $('accounts-summary')
        if (!el) return
        const enabled = accountsCache.filter(a => a.enabled).length
        const pending = accountsCache.filter(a => a.enabled && !a.finishedToday).length
        const open = accountsCache.filter(a => a.sessionOpen).length
        const pointsTotal = accountsCache.reduce((sum, a) => sum + (a.dashboardStats?.availablePoints ?? 0), 0)
        const farmedToday = accountsCache.reduce((sum, a) => sum + (a.runStats?.collectedToday ?? 0), 0)
        let text = enabled + ' enabled · ' + pending + ' pending'
        if (open) text += ' · ' + open + ' browser' + (open === 1 ? '' : 's') + ' open'
        if (pointsTotal > 0) text += ' · ' + formatPoints(pointsTotal) + ' pts saved'
        if (farmedToday > 0) text += ' · +' + formatPoints(farmedToday) + ' farmed today'
        el.textContent = text
    }
    function filterAccounts(list) {
        const q = ($('account-search')?.value || '').trim().toLowerCase()
        const pendingOnly = $('filter-pending')?.checked
        return list.filter(a => {
            if (q && !a.email.toLowerCase().includes(q)) return false
            if (pendingOnly && a.finishedToday) return false
            return true
        })
    }

    function renderAccountRow(account) {
        const running = $('btn-run')?.disabled
        const row = document.createElement('article')
        row.className = 'acc-row' +
            (!account.enabled ? ' disabled' : '') +
            (account.sessionOpen ? ' session-open' : '') +
            (account.searchIssue === 'stale_session' ? ' stale-session' : '')

        const statusClass = account.sessionOpen
            ? 'live'
            : account.searchIssue === 'stale_session'
            ? 'stale-session'
            : account.searchIssue === 'needs_sign_in'
            ? 'signin'
            : account.searchIssue === 'temp_banned'
            ? 'warn'
            : !account.enabled
            ? 'off'
            : account.finishedToday
            ? 'done'
            : 'pending'
        const statusLabel = account.sessionOpen
            ? account.sessionPlatform === 'mobile'
                ? 'Mobile browser open'
                : 'Desktop browser open'
            : account.searchIssue === 'stale_session'
            ? 'Clear session'
            : account.searchIssue === 'needs_sign_in'
            ? 'Bing sign-in'
            : account.searchIssue === 'temp_banned'
            ? 'Search limited'
            : !account.enabled
            ? 'Disabled'
            : account.finishedToday
            ? 'Done today'
            : 'Pending'

        const avatar = accountAvatarColor(account.email)

        row.innerHTML =
            '<div class="acc-row-avatar" style="background:' + avatar.bg + ';color:' + avatar.fg + '">' +
            escapeHtml(initials(account.email)) + '</div>' +
            '<div class="acc-row-main">' +
            '<div class="acc-row-email">' + escapeHtml(account.email) + '</div>' +
            '<div class="acc-row-meta">' +
            (account.hasPassword ? '' : '<span class="warn-tag">No password</span>') +
            (account.hasTotp ? '<span class="warn-tag" style="background:rgba(59,130,246,.12);color:#93c5fd">TOTP</span>' : '') +
            (account.searchIssue === 'needs_sign_in' ? '<span class="warn-tag" style="background:rgba(251,191,36,.12);color:#fbbf24">Sign in to Bing locally</span>' : '') +
            (account.searchIssue === 'stale_session' ? '<span class="warn-tag" style="background:rgba(239,68,68,.14);color:#fca5a5">Clear saved session &amp; sign in again</span>' : '') +
            (account.searchIssue === 'temp_banned' ? '<span class="warn-tag">Bing search restricted today</span>' : '') +
            formatDashboardStatsHtml(account.dashboardStats) +
            formatRunStatsHtml(account.runStats) +
            '</div></div>' +
            '<div class="acc-locale">' +
            '<label class="locale-pill">Geo<input type="text" class="acc-geo" value="' + escapeHtml(account.geoLocale) + '" maxlength="4"></label>' +
            '<label class="locale-pill">Lang<input type="text" class="acc-lang" value="' + escapeHtml(account.langCode) + '" maxlength="5"></label>' +
            '</div>' +
            '<label class="acc-row-toggle toggle-switch" title="Enable account">' +
            '<input type="checkbox" class="acc-enabled" ' + (account.enabled ? 'checked' : '') + '>' +
            '<span class="slider"></span></label>' +
            '<div class="acc-row-status">' +
            '<span class="status-pill ' + statusClass + '"><span class="dot"></span>' + statusLabel + '</span></div>' +
            '<div class="acc-row-actions">' +
            (account.sessionOpen
                ? '<button type="button" class="icon-btn close-session" title="Close browser">' + ICONS.close + ' Close</button>'
                : account.searchIssue === 'needs_sign_in'
                ? '<button type="button" class="icon-btn signin-bing" title="Open visible browser to sign in to Bing"' + (running ? ' disabled' : '') + '>' + ICONS.open + ' Sign in</button>'
                : '<button type="button" class="icon-btn open" title="Open desktop session"' + (running ? ' disabled' : '') + '>' + ICONS.open + ' Desktop</button>' +
                  '<button type="button" class="icon-btn open-mobile" title="Open mobile session"' + (running ? ' disabled' : '') + '>' + ICONS.mobile + ' Mobile</button>') +
            '<button type="button" class="icon-btn run" title="Run this account"' + (running ? ' disabled' : '') + '>' + ICONS.run + ' Run</button>' +
            '<button type="button" class="icon-btn clear' + (account.searchIssue === 'stale_session' ? ' emphasis' : '') + '" title="Clear saved session">' + ICONS.clear + (account.searchIssue === 'stale_session' ? ' Clear' : '') + '</button>' +
            '</div>'

        const enabledCb = row.querySelector('.acc-enabled')
        const geoIn = row.querySelector('.acc-geo')
        const langIn = row.querySelector('.acc-lang')

        const save = async () => {
            try {
                await api('/api/accounts/' + encodeURIComponent(account.email), {
                    method: 'PATCH',
                    body: JSON.stringify({ enabled: enabledCb.checked, geoLocale: geoIn.value, langCode: langIn.value })
                })
                showToast('Saved ' + maskEmail(account.email), 'success')
                await refreshAccounts()
                await refreshStatus()
            } catch (e) { showToast(e.message, 'error') }
        }

        enabledCb.addEventListener('change', save)
        geoIn.addEventListener('change', save)
        langIn.addEventListener('change', save)

        row.querySelector('.icon-btn.run')?.addEventListener('click', () => {
            openRunModal({ focusEmail: account.email })
        })

        row.querySelector('.icon-btn.open')?.addEventListener('click', async () => {
            try {
                await api('/api/accounts/' + encodeURIComponent(account.email) + '/open', {
                    method: 'POST',
                    body: JSON.stringify({ target: 'rewards', platform: 'desktop' })
                })
                showToast('Opening desktop browser for ' + maskEmail(account.email), 'success')
                setTimeout(() => refreshAccounts().catch(() => {}), 800)
            } catch (e) { showToast(e.message, 'error') }
        })

        row.querySelector('.icon-btn.open-mobile')?.addEventListener('click', async () => {
            try {
                await api('/api/accounts/' + encodeURIComponent(account.email) + '/open', {
                    method: 'POST',
                    body: JSON.stringify({ target: 'rewards', platform: 'mobile' })
                })
                showToast('Opening mobile browser for ' + maskEmail(account.email), 'success')
                setTimeout(() => refreshAccounts().catch(() => {}), 800)
            } catch (e) { showToast(e.message, 'error') }
        })

        row.querySelector('.icon-btn.signin-bing')?.addEventListener('click', async () => {
            try {
                await api('/api/accounts/' + encodeURIComponent(account.email) + '/open', {
                    method: 'POST',
                    body: JSON.stringify({ target: 'bing', platform: 'desktop' })
                })
                showToast('Opening Bing sign-in for ' + maskEmail(account.email), 'success')
                setTimeout(() => refreshAccounts().catch(() => {}), 800)
            } catch (e) { showToast(e.message, 'error') }
        })

        row.querySelector('.icon-btn.close-session')?.addEventListener('click', async () => {
            try {
                await api('/api/accounts/' + encodeURIComponent(account.email) + '/open', { method: 'DELETE' })
                showToast('Browser closed', 'success')
                await refreshAccounts()
            } catch (e) { showToast(e.message, 'error') }
        })

        row.querySelector('.icon-btn.clear')?.addEventListener('click', async () => {
            if (!confirm('Clear saved session for ' + account.email + '?')) return
            try {
                await api('/api/accounts/' + encodeURIComponent(account.email) + '/session', { method: 'DELETE' })
                showToast('Session cleared', 'success')
                await refreshAccounts()
            } catch (e) { showToast(e.message, 'error') }
        })

        return row
    }

    function paintAccountsTable() {
        const container = $('accounts-list')
        if (!container) return
        const filtered = filterAccounts(accountsCache)
        container.innerHTML = ''
        if (!filtered.length) {
            container.innerHTML = '<div class="card runs-empty">No accounts match your filters.</div>'
            return
        }
        for (const account of filtered) {
            container.appendChild(renderAccountRow(account))
        }
        paintAccountsSummary()
    }

    async function refreshAccounts() {
        const data = await api('/api/accounts')
        accountsCache = data.accounts
        paintAccountsTable()
        paintDashboardAccounts()
        paintStaleSessionAlert(accountsCache.filter(a => a.searchIssue === 'stale_session').map(a => a.email))
    }

    let analyticsCache = null

    function levelTone(level) {
        const key = String(level || '').toLowerCase()
        if (key.includes('gold')) return 'gold'
        if (key.includes('silver')) return 'silver'
        if (key.includes('level 2') || key === '2') return 'lvl2'
        if (key.includes('level 1') || key === '1') return 'lvl1'
        return 'unknown'
    }

    function shortDate(iso) {
        if (!iso) return '—'
        const d = new Date(iso + 'T12:00:00')
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    }

    function renderBarChart(daily, key) {
        if (!daily.length) {
            return '<p class="analytics-empty">No harvest data yet — run your accounts to see trends.</p>'
        }
        const w = 640
        const h = 200
        const pad = { l: 36, r: 12, t: 16, b: 32 }
        const innerW = w - pad.l - pad.r
        const innerH = h - pad.t - pad.b
        const max = Math.max(...daily.map(d => d[key] || 0), 1)
        const barW = Math.max(4, Math.min(18, innerW / daily.length - 3))
        const gap = (innerW - barW * daily.length) / Math.max(daily.length - 1, 1)

        let bars = ''
        daily.forEach((day, i) => {
            const val = day[key] || 0
            const barH = (val / max) * innerH
            const x = pad.l + i * (barW + gap)
            const y = pad.t + innerH - barH
            const hot = val === max && val > 0
            bars +=
                '<rect class="analytics-bar' + (hot ? ' hot' : '') + '" x="' + x + '" y="' + y + '" width="' + barW + '" height="' + barH + '" rx="3">' +
                '<title>' + escapeHtml(day.date) + ': ' + val.toLocaleString() + ' pts</title></rect>'
        })

        const ticks = [0, 0.5, 1].map(r => {
            const y = pad.t + innerH * (1 - r)
            const v = Math.round(max * r)
            return '<line class="analytics-grid-line" x1="' + pad.l + '" y1="' + y + '" x2="' + (w - pad.r) + '" y2="' + y + '"/>' +
                '<text class="analytics-axis" x="' + (pad.l - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + v.toLocaleString() + '</text>'
        }).join('')

        const labels = daily.length <= 12
            ? daily.map((day, i) => {
                if (daily.length > 8 && i % 2 !== 0 && i !== daily.length - 1) return ''
                const x = pad.l + i * (barW + gap) + barW / 2
                return '<text class="analytics-axis" x="' + x + '" y="' + (h - 8) + '" text-anchor="middle">' + shortDate(day.date) + '</text>'
            }).join('')
            : '<text class="analytics-axis" x="' + (w / 2) + '" y="' + (h - 8) + '" text-anchor="middle">' +
                shortDate(daily[0].date) + ' → ' + shortDate(daily[daily.length - 1].date) + '</text>'

        return '<svg class="analytics-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">' +
            ticks + bars + labels + '</svg>'
    }

    function renderForecastChart(forecast) {
        if (!forecast.length) {
            return '<p class="analytics-empty">Forecast unlocks after a few days of runs.</p>'
        }
        const w = 720
        const h = 240
        const pad = { l: 44, r: 16, t: 18, b: 34 }
        const innerW = w - pad.l - pad.r
        const innerH = h - pad.t - pad.b
        const actual = forecast.filter(p => p.cumulativeActual !== undefined)
        const allCum = forecast.map(p => p.cumulativeForecast ?? p.cumulativeActual ?? 0)
        const max = Math.max(...allCum, 1)
        const n = forecast.length

        function xAt(i) {
            return pad.l + (i / Math.max(n - 1, 1)) * innerW
        }
        function yAt(v) {
            return pad.t + innerH - (v / max) * innerH
        }

        let actualPath = ''
        actual.forEach((p, i) => {
            const idx = forecast.indexOf(p)
            const cmd = i === 0 ? 'M' : 'L'
            actualPath += cmd + xAt(idx) + ' ' + yAt(p.cumulativeActual) + ' '
        })

        const splitIdx = actual.length ? forecast.indexOf(actual[actual.length - 1]) : 0
        let forecastPath = ''
        forecast.slice(splitIdx).forEach((p, i) => {
            const idx = splitIdx + i
            const val = p.cumulativeForecast ?? p.cumulativeActual ?? 0
            forecastPath += (i === 0 ? 'M' : 'L') + xAt(idx) + ' ' + yAt(val) + ' '
        })

        const areaPath = actualPath +
            ' L' + xAt(splitIdx) + ' ' + (pad.t + innerH) +
            ' L' + xAt(0) + ' ' + (pad.t + innerH) + ' Z'

        const legend =
            '<g class="analytics-legend">' +
            '<line x1="' + (w - 190) + '" y1="14" x2="' + (w - 170) + '" y2="14" class="analytics-legend-line actual"/>' +
            '<text x="' + (w - 164) + '" y="18">Actual</text>' +
            '<line x1="' + (w - 100) + '" y1="14" x2="' + (w - 80) + '" y2="14" class="analytics-legend-line forecast"/>' +
            '<text x="' + (w - 74) + '" y="18">Forecast</text></g>'

        return '<svg class="analytics-svg tall" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">' +
            '<path class="analytics-area" d="' + areaPath + '"/>' +
            '<path class="analytics-line actual" d="' + actualPath + '"/>' +
            '<path class="analytics-line forecast" d="' + forecastPath + '"/>' +
            '<line class="analytics-split" x1="' + xAt(splitIdx) + '" y1="' + pad.t + '" x2="' + xAt(splitIdx) + '" y2="' + (pad.t + innerH) + '"/>' +
            '<text class="analytics-axis" x="' + (pad.l - 8) + '" y="' + (pad.t + 4) + '" text-anchor="end">' + Math.round(max).toLocaleString() + '</text>' +
            '<text class="analytics-axis" x="' + (pad.l - 8) + '" y="' + (pad.t + innerH) + '" text-anchor="end">0</text>' +
            legend +
            '</svg>'
    }

    function paintAnalyticsKpis(report) {
        const grid = $('analytics-kpi-grid')
        if (!grid) return
        const s = report.summary
        const goal = report.goal
        const cards = [
            {
                label: 'Harvested (' + report.period.days + 'd)',
                value: s.totalCollected.toLocaleString(),
                hint: s.avgDailyCollected.toLocaleString() + ' pts/day average',
                tone: 'success'
            },
            {
                label: 'Projected month',
                value: s.projectedMonthly.toLocaleString(),
                hint: 'Based on last 7 active days',
                tone: 'accent'
            },
            {
                label: 'Accounts',
                value: s.enabledAccounts,
                hint: s.activeAccounts + ' ran in this period',
                tone: ''
            },
            {
                label: 'Wallet total',
                value: s.totalAvailablePoints.toLocaleString(),
                hint: 'Available points across farm',
                tone: ''
            }
        ]
        if (goal) {
            cards.push({
                label: 'At goal',
                value: s.accountsAtGoal + ' / ' + s.enabledAccounts,
                hint: (goal.pointsTarget.toLocaleString() + ' pts each in ' + report.period.days + 'd'),
                tone: s.accountsAtGoal === s.enabledAccounts ? 'success' : ''
            })
            cards.push({
                label: goal.label || 'Avg progress',
                value: s.goalProgressPercent + '%',
                hint: s.accountsOnTrack + ' on track · ~' + (s.avgPointsToGoal ?? 0).toLocaleString() + ' pts left avg',
                tone: s.onTrackForGoal ? 'success' : 'warn'
            })
        }
        grid.innerHTML = cards.map(card =>
            '<article class="analytics-kpi' + (card.tone ? ' tone-' + card.tone : '') + '">' +
            '<span class="analytics-kpi-label">' + escapeHtml(card.label) + '</span>' +
            '<strong class="analytics-kpi-value">' + escapeHtml(card.value) + '</strong>' +
            '<span class="analytics-kpi-hint">' + escapeHtml(card.hint) + '</span></article>'
        ).join('')
    }

    function paintGoalRing(report) {
        const ring = $('analytics-goal-ring')
        const insight = $('analytics-goal-insight')
        const caption = $('analytics-goal-caption')
        if (!ring || !insight) return

        const goal = report.goal
        const s = report.summary
        if (!goal) {
            if (caption) caption.textContent = 'Set a per-account target above'
            ring.innerHTML = '<div class="analytics-goal-empty"><span>?</span><p>No goal yet</p></div>'
            insight.innerHTML = '<p>Set a <strong>per-account</strong> points target — for example <strong>6,500</strong> — to track each account toward the same goal.</p>'
            return
        }

        const pct = Math.min(100, s.goalProgressPercent)
        const r = 54
        const c = 2 * Math.PI * r
        const dash = (pct / 100) * c
        if (caption) {
            caption.textContent =
                goal.label + ' · ' + goal.pointsTarget.toLocaleString() + ' pts per account'
        }

        ring.innerHTML =
            '<svg class="analytics-ring-svg" viewBox="0 0 140 140">' +
            '<circle class="analytics-ring-track" cx="70" cy="70" r="' + r + '"/>' +
            '<circle class="analytics-ring-progress' + (s.onTrackForGoal ? ' on-track' : ' behind') + '" cx="70" cy="70" r="' + r + '" ' +
            'transform="rotate(-90 70 70)" stroke-dasharray="' + dash + ' ' + c + '" stroke-dashoffset="0"/>' +
            '<text class="analytics-ring-pct" x="70" y="64" text-anchor="middle">' + pct + '%</text>' +
            '<text class="analytics-ring-sub" x="70" y="82" text-anchor="middle">avg per account</text>' +
            '<text class="analytics-ring-sub" x="70" y="96" text-anchor="middle">' + s.accountsAtGoal + '/' + s.enabledAccounts + ' reached</text>' +
            '</svg>'

        let eta = 'Run accounts more to estimate when lagging ones hit the target.'
        if (s.accountsAtGoal === s.enabledAccounts) {
            eta = 'Every enabled account has hit <strong>' + goal.pointsTarget.toLocaleString() + '</strong> pts in this period.'
        } else if (s.daysToGoal !== null && s.estimatedGoalDate) {
            eta = 'Lagging accounts need about <strong>' + s.daysToGoal + ' day' + (s.daysToGoal === 1 ? '' : 's') + '</strong> at current pace (' + shortDate(s.estimatedGoalDate) + ').'
        }
        const track = s.onTrackForGoal === null
            ? ''
            : s.onTrackForGoal
                ? '<span class="analytics-pill good">' + s.accountsOnTrack + ' on track</span>'
                : '<span class="analytics-pill warn">' + (s.enabledAccounts - s.accountsOnTrack) + ' behind</span>'

        insight.innerHTML =
            track +
            '<p>' + eta + '</p>' +
            '<p class="analytics-muted">Farm total this period: <strong>' + s.totalCollected.toLocaleString() + '</strong> pts across all accounts.</p>'
    }

    function paintAnalyticsLevels(levels) {
        const el = $('analytics-levels')
        if (!el) return
        if (!levels.length) {
            el.innerHTML = '<p class="analytics-empty">Enable accounts and run dashboard info to map levels.</p>'
            return
        }
        const max = Math.max(...levels.map(l => l.count), 1)
        el.innerHTML = levels.map(bucket => {
            const pct = Math.round((bucket.count / max) * 100)
            return '<div class="analytics-level-row tone-' + levelTone(bucket.level) + '">' +
                '<div class="analytics-level-head"><span class="analytics-level-name">' + escapeHtml(bucket.level) + '</span>' +
                '<span class="analytics-level-count">' + bucket.count + '</span></div>' +
                '<div class="analytics-level-bar"><span style="width:' + pct + '%"></span></div></div>'
        }).join('')
    }

    function paintAnalyticsAccounts(report) {
        const el = $('analytics-accounts')
        const caption = $('analytics-accounts-caption')
        if (!el) return
        if (caption) {
            caption.textContent = report.period.start + ' → ' + report.period.end + ' · ' + report.accounts.length + ' accounts'
        }
        if (!report.accounts.length) {
            el.innerHTML = '<p class="analytics-empty">No accounts in this period.</p>'
            return
        }
        const hasGoal = !!report.goal
        el.innerHTML =
            '<div class="analytics-account-head' + (hasGoal ? ' has-goal' : '') + '">' +
            '<span>Account</span><span>Level</span><span>Harvested</span>' +
            (hasGoal ? '<span>Goal</span>' : '') +
            '<span>Share</span><span>Proj. month</span></div>' +
            report.accounts.map((row, i) => {
                const rank = i < 3 ? ' rank-' + (i + 1) : ''
                const level = row.level
                    ? '<span class="analytics-level-chip tone-' + levelTone(row.level) + '">' + escapeHtml(row.level) + '</span>'
                    : '<span class="analytics-muted">—</span>'
                let goalCell = ''
                if (hasGoal) {
                    const gp = row.goalProgressPercent ?? 0
                    const reached = row.goalReached
                    const onTrack = row.onTrackForGoal
                    const goalClass = reached ? ' reached' : onTrack ? ' on-track' : ' behind'
                    goalCell =
                        '<span class="analytics-goal-cell' + goalClass + '">' +
                        '<span class="analytics-share-bar goal"><i style="width:' + Math.min(100, gp) + '%"></i></span> ' +
                        (reached ? 'Done' : gp + '%') +
                        '</span>'
                }
                return '<div class="analytics-account-row' + rank + (hasGoal ? ' has-goal' : '') + '">' +
                    '<span class="analytics-account-email" title="' + escapeHtml(row.email) + '">' + escapeHtml(row.email) + '</span>' +
                    '<span>' + level + '</span>' +
                    '<span class="analytics-account-pts">' + row.collected.toLocaleString() + '</span>' +
                    (hasGoal ? '<span>' + goalCell + '</span>' : '') +
                    '<span><span class="analytics-share-bar"><i style="width:' + Math.min(100, row.sharePercent) + '%"></i></span> ' + row.sharePercent + '%</span>' +
                    '<span class="analytics-muted">' + row.projectedMonthly.toLocaleString() + '</span></div>'
            }).join('')
    }

    function paintAnalytics(report) {
        analyticsCache = report
        const goal = report.goal
        if ($('analytics-goal-label')) $('analytics-goal-label').value = goal?.label || ''
        if ($('analytics-goal-points')) $('analytics-goal-points').value = goal?.pointsTarget ?? ''
        if ($('analytics-goal-days')) $('analytics-goal-days').value = goal?.periodDays ?? 30

        const dailyCap = $('analytics-daily-caption')
        if (dailyCap) {
            dailyCap.textContent = report.period.daysWithData + ' active days · ' + report.period.start + ' → ' + report.period.end
        }

        paintAnalyticsKpis(report)
        const dailyChart = $('analytics-daily-chart')
        if (dailyChart) dailyChart.innerHTML = renderBarChart(report.daily, 'collected')
        paintGoalRing(report)
        const forecastChart = $('analytics-forecast-chart')
        if (forecastChart) forecastChart.innerHTML = renderForecastChart(report.forecast)
        paintAnalyticsLevels(report.levels)
        paintAnalyticsAccounts(report)
    }

    async function refreshAnalytics() {
        const data = await api('/api/analytics')
        paintAnalytics(data.analytics)
    }

    async function saveAnalyticsGoal(ev) {
        if (ev) ev.preventDefault()
        const pointsTarget = Number($('analytics-goal-points')?.value)
        const periodDays = Number($('analytics-goal-days')?.value || 30)
        const label = $('analytics-goal-label')?.value?.trim() || ''
        if (!Number.isFinite(pointsTarget) || pointsTarget <= 0) {
            showToast('Enter a positive points target', 'error')
            return
        }
        const data = await api('/api/analytics/goal', {
            method: 'PATCH',
            body: JSON.stringify({ pointsTarget, periodDays, label })
        })
        paintAnalytics(data.analytics)
        showToast('Goal saved', 'success')
    }

    function renderWorkerGroup(containerId, keys, workers) {
        const grid = $(containerId)
        if (!grid) return
        grid.innerHTML = ''
        for (const key of keys) {
            if (!(key in workers)) continue
            const on = !!workers[key]
            const label = document.createElement('label')
            label.className = 'worker-card' + (on ? ' on' : '')
            label.innerHTML =
                '<input type="checkbox" data-worker="' + key + '" ' + (on ? 'checked' : '') + '>' +
                '<span class="worker-card-check"></span>' +
                '<div class="worker-card-body">' +
                '<strong>' + escapeHtml(WORKER_LABELS[key] || key) + '</strong>' +
                '<span>' + escapeHtml(WORKER_HINTS[key] || '') + '</span></div>'
            const cb = label.querySelector('input')
            cb.addEventListener('change', () => label.classList.toggle('on', cb.checked))
            grid.appendChild(label)
        }
    }

    function renderWorkers(workers) {
        renderWorkerGroup('workers-promo', WORKER_GROUPS.promo, workers)
        renderWorkerGroup('workers-search', WORKER_GROUPS.search, workers)
        renderWorkerGroup('workers-other', WORKER_GROUPS.other, workers)
    }

    function setAllWorkers(on) {
        document.querySelectorAll('[data-worker]').forEach(cb => {
            cb.checked = on
            cb.closest('.worker-card')?.classList.toggle('on', on)
        })
    }

    function normalizeTimeValue(value) {
        if (!value) return '08:00'
        const raw = String(value).trim()
        if (/^\d{1,2}:\d{2}$/.test(raw)) {
            const [h, m] = raw.split(':')
            return String(h).padStart(2, '0') + ':' + m
        }
        return raw
    }

    async function loadConfig() {
        const data = await api('/api/config')
        configCache = data.config
        renderWorkers(configCache.workers)

        if ($('cfg-headless')) $('cfg-headless').checked = configCache.headless
        if ($('cfg-clusters')) setCfgClusters(configCache.clusters)
        if ($('cfg-bing-local')) $('cfg-bing-local').checked = configCache.searchOnBingLocalQueries
        if ($('quick-headless')) $('quick-headless').checked = configCache.headless
        updateHeadlessLabel(configCache.headless, 'quick-headless-label')
        setQuickClusters(configCache.clusters)
        syncDashControls(configCache.clusters, configCache.headless)
        if ($('quick-panel-startup')) $('quick-panel-startup').checked = configCache.controlPanel?.runOnStartup !== false

        const sched = configCache.scheduler || {}
        if ($('cfg-sched-enabled')) $('cfg-sched-enabled').checked = !!sched.enabled
        if ($('cfg-sched-startup')) $('cfg-sched-startup').checked = sched.runOnStartup !== false
        if ($('cfg-sched-tz')) $('cfg-sched-tz').value = sched.timezone || 'UTC'
        if ($('cfg-sched-time')) $('cfg-sched-time').value = normalizeTimeValue(sched.startTime || '08:00')

        const sd = configCache.searchSettings?.searchDelay || {}
        const rd = configCache.searchSettings?.readDelay || {}
        if ($('cfg-search-min')) $('cfg-search-min').value = delayToSeconds(sd.min)
        if ($('cfg-search-max')) $('cfg-search-max').value = delayToSeconds(sd.max)
        if ($('cfg-read-min')) $('cfg-read-min').value = delayToSeconds(rd.min)
        if ($('cfg-read-max')) $('cfg-read-max').value = delayToSeconds(rd.max)

        const filter = configCache.consoleLogFilter || {}
        document.querySelectorAll('.log-filter').forEach(cb => {
            cb.checked = filter.levels ? filter.levels.includes(cb.dataset.log) : filter[cb.dataset.log] !== false
        })

        paintSettingsSummary(configCache)
    }

    function collectWorkersPatch() {
        const workers = { ...configCache.workers }
        document.querySelectorAll('[data-worker]').forEach(cb => { workers[cb.dataset.worker] = cb.checked })
        return workers
    }

    function renderLogLine(entry) {
        const level = (entry.level || 'info').toLowerCase()
        const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''
        const account = entry.account ? '[' + entry.account.split('@')[0] + '] ' : ''
        const msg = entry.message || entry.content || ''
        return '<span class="log-line ' + level + '">' + escapeHtml(ts + ' ' + level.toUpperCase().padEnd(5) + ' ' + account + msg) + '</span>\n'
    }

    function passesLogFilter(entry) {
        const levelFilter = $('log-level-filter')?.value
        if (levelFilter && (entry.level || '').toLowerCase() !== levelFilter) return false
        const accountFilter = ($('log-account-filter')?.value || '').trim().toLowerCase()
        if (accountFilter && !(entry.account || '').toLowerCase().includes(accountFilter)) return false
        return true
    }

    function paintLogs() {
        const terminal = $('log-terminal')
        if (!terminal) return
        terminal.innerHTML = logs.filter(passesLogFilter).map(renderLogLine).join('')
        if ($('log-autoscroll')?.checked) terminal.scrollTop = terminal.scrollHeight
    }

    function appendLog(entry) {
        logs.push(entry)
        if (logs.length > 500) logs.splice(0, logs.length - 500)
        if (!passesLogFilter(entry)) return
        const terminal = $('log-terminal')
        if (!terminal) return
        terminal.innerHTML += renderLogLine(entry)
        if ($('log-autoscroll')?.checked) terminal.scrollTop = terminal.scrollHeight
    }

    function connectLogStream() {
        if (logEventSource) logEventSource.close()
        logEventSource = new EventSource('/api/logs/stream?token=' + encodeURIComponent(token))
        logEventSource.onmessage = ev => {
            if (logPaused) return
            try { appendLog(JSON.parse(ev.data)) } catch { /* ignore */ }
        }
        logEventSource.addEventListener('passwordless-prompt', ev => {
            try { showPasswordlessModal(JSON.parse(ev.data)) } catch { /* ignore */ }
        })
        logEventSource.addEventListener('passwordless-prompt-clear', ev => {
            try {
                const data = JSON.parse(ev.data)
                if (!activePasswordlessPrompt || activePasswordlessPrompt.id === data.id) {
                    closePasswordlessModal()
                }
            } catch { /* ignore */ }
        })
        logEventSource.onerror = () => {
            setConnected(false)
            logEventSource.close()
            setTimeout(connectLogStream, 3000)
        }
    }

    function notifyPasswordlessPrompt(prompt) {
        if (!('Notification' in window)) return
        const body = prompt.number
            ? 'Select number ' + prompt.number + ' in Microsoft Authenticator'
            : 'Approve the sign-in request in Microsoft Authenticator'
        try {
            if (Notification.permission === 'granted') {
                new Notification('Approve Microsoft sign-in', { body, requireInteraction: true })
            } else if (Notification.permission === 'default') {
                Notification.requestPermission().then(permission => {
                    if (permission === 'granted') {
                        new Notification('Approve Microsoft sign-in', { body, requireInteraction: true })
                    }
                }).catch(() => undefined)
            }
        } catch { /* ignore */ }
    }

    function startPasswordlessCountdown(prompt) {
        if (passwordlessCountdownTimer) clearInterval(passwordlessCountdownTimer)
        const started = new Date(prompt.startedAt).getTime()
        const deadline = started + (prompt.timeoutSeconds || 180) * 1000
        const modalCountdown = $('passwordless-countdown')
        const noticeCountdown = $('passwordless-notice-countdown')
        const tick = () => {
            const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
            const label = left + 's remaining'
            const shortLabel = left + 's'
            if (modalCountdown) modalCountdown.textContent = label
            if (noticeCountdown) noticeCountdown.textContent = shortLabel
            if (left <= 0 && passwordlessCountdownTimer) {
                clearInterval(passwordlessCountdownTimer)
                passwordlessCountdownTimer = null
            }
        }
        tick()
        passwordlessCountdownTimer = setInterval(tick, 1000)
    }

    function paintPasswordlessNotice(prompt) {
        const notice = $('passwordless-notice')
        const emailEl = $('passwordless-notice-email')
        const numberEl = $('passwordless-notice-number')
        const platformEl = $('passwordless-notice-platform')
        if (!notice) return

        if (emailEl) emailEl.textContent = prompt.email || 'Unknown account'
        if (platformEl) {
            platformEl.textContent = prompt.platform === 'mobile' ? 'Mobile' : 'Desktop'
        }
        if (numberEl) {
            if (prompt.number) {
                numberEl.textContent = prompt.number
                numberEl.classList.remove('missing')
            } else {
                numberEl.textContent = 'Check app'
                numberEl.classList.add('missing')
            }
        }

        notice.classList.remove('hidden')
    }

    function hidePasswordlessNotice() {
        $('passwordless-notice')?.classList.add('hidden')
    }

    function showPasswordlessModal(prompt) {
        if (!prompt) return
        activePasswordlessPrompt = prompt
        paintPasswordlessNotice(prompt)
        startPasswordlessCountdown(prompt)
        notifyPasswordlessPrompt(prompt)
    }

    function closePasswordlessModal() {
        if (passwordlessCountdownTimer) {
            clearInterval(passwordlessCountdownTimer)
            passwordlessCountdownTimer = null
        }
        activePasswordlessPrompt = null
        $('passwordless-modal')?.classList.add('hidden')
        hidePasswordlessNotice()
    }

    async function loadPasswordlessPrompt() {
        try {
            const data = await api('/api/passwordless-prompt')
            if (data.prompt) showPasswordlessModal(data.prompt)
        } catch { /* ignore */ }
    }

    async function loadInitialLogs() {
        const data = await api('/api/logs')
        logs.length = 0
        for (const entry of data.logs || []) logs.push(entry)
        paintLogs()
    }

    function accountRunTags(account) {
        const tags = []
        if (!account.enabled) tags.push({ cls: 'off', label: 'Disabled' })
        else if (account.finishedToday) tags.push({ cls: 'done', label: 'Done today' })
        else tags.push({ cls: 'pending', label: 'Pending' })
        if (account.searchIssue === 'temp_banned') tags.push({ cls: 'warn', label: 'Search limited' })
        if (account.searchIssue === 'stale_session') tags.push({ cls: 'stale-session', label: 'Clear session' })
        if (account.searchIssue === 'needs_sign_in') tags.push({ cls: 'signin', label: 'Sign in' })
        return tags
    }

    function getRunModalFilteredAccounts() {
        const q = ($('run-modal-search')?.value || '').trim().toLowerCase()
        return accountsCache.filter(a => !q || a.email.toLowerCase().includes(q))
    }

    function updateRunModalCount() {
        const count = runModalSelected.size
        const countEl = $('run-modal-count')
        const startBtn = $('run-modal-start')
        if (countEl) {
            countEl.textContent = count + ' account' + (count === 1 ? '' : 's') + ' selected'
        }
        if (startBtn) {
            startBtn.disabled = count === 0
            startBtn.textContent = count ? 'Start run (' + count + ')' : 'Start run'
        }
    }

    function paintRunModalList() {
        const list = $('run-modal-list')
        if (!list) return
        const filtered = getRunModalFilteredAccounts()
        if (!filtered.length) {
            list.innerHTML = '<div class="run-modal-empty">No accounts match your search.</div>'
            updateRunModalCount()
            return
        }

        list.innerHTML = filtered.map(account => {
            const key = account.email.toLowerCase()
            const checked = runModalSelected.has(key)
            const avatar = accountAvatarColor(account.email)
            const tags = accountRunTags(account)
            return (
                '<label class="run-modal-item' + (checked ? ' selected' : '') + '" data-email="' + escapeHtml(account.email) + '">' +
                '<input type="checkbox"' + (checked ? ' checked' : '') + ' aria-label="Include ' + escapeHtml(account.email) + '">' +
                '<div class="acc-avatar" style="background:' + avatar.bg + ';color:' + avatar.fg + ';width:34px;height:34px;font-size:0.72rem">' +
                escapeHtml(initials(account.email)) + '</div>' +
                '<div class="run-modal-item-main">' +
                '<div class="run-modal-email">' + escapeHtml(account.email) + '</div>' +
                '<div class="run-modal-tags">' +
                tags.map(t => '<span class="run-modal-tag ' + t.cls + '">' + escapeHtml(t.label) + '</span>').join('') +
                '</div></div></label>'
            )
        }).join('')

        list.querySelectorAll('.run-modal-item').forEach(row => {
            const email = row.dataset.email
            const key = email.toLowerCase()
            const cb = row.querySelector('input[type="checkbox"]')
            cb.addEventListener('change', () => {
                if (cb.checked) {
                    runModalSelected.add(key)
                    row.classList.add('selected')
                } else {
                    runModalSelected.delete(key)
                    row.classList.remove('selected')
                }
                updateRunModalCount()
            })
        })
        updateRunModalCount()
    }

    function selectRunModalAccounts(mode) {
        runModalSelected.clear()
        const filtered = getRunModalFilteredAccounts()
        const pick = filtered.filter(a => {
            if (mode === 'pending') return a.enabled && !a.finishedToday
            if (mode === 'enabled') return a.enabled
            return true
        })
        for (const account of pick) {
            runModalSelected.add(account.email.toLowerCase())
        }
        paintRunModalList()
    }

    async function openRunModal(options) {
        if ($('btn-run')?.disabled) {
            showToast('Bot is already running', 'error')
            return
        }

        if (!accountsCache.length) {
            try {
                await refreshAccounts()
            } catch (e) {
                showToast(e.message, 'error')
                return
            }
        }

        runModalSelected.clear()
        const focusEmail = options?.focusEmail
        if (focusEmail) {
            runModalSelected.add(focusEmail.toLowerCase())
        } else {
            for (const account of accountsCache) {
                if (account.enabled && !account.finishedToday) {
                    runModalSelected.add(account.email.toLowerCase())
                }
            }
        }

        if ($('run-modal-search')) $('run-modal-search').value = ''
        const ignoreTempBan = $('run-modal-ignore-tempban')
        if (ignoreTempBan) {
            const saved = sessionStorage.getItem('msrb-ignore-tempban')
            ignoreTempBan.checked = saved === '1'
        }
        const sub = $('run-modal-sub')
        if (sub) {
            sub.textContent = focusEmail
                ? 'This account is selected. Add or remove others before starting.'
                : 'Pending accounts are pre-selected. Include completed or limited accounts if you want to re-run them.'
        }

        paintRunModalList()
        $('run-modal')?.classList.remove('hidden')
        $('run-modal-search')?.focus()
    }

    function closeRunModal() {
        $('run-modal')?.classList.add('hidden')
    }

    async function confirmRunModal() {
        const emails = []
        for (const key of runModalSelected) {
            const account = accountsCache.find(a => a.email.toLowerCase() === key)
            if (account) emails.push(account.email)
        }
        if (!emails.length) {
            showToast('Select at least one account', 'error')
            return
        }
        closeRunModal()
        const ignoreTempBan = $('run-modal-ignore-tempban')?.checked === true
        if ($('run-modal-ignore-tempban')) {
            sessionStorage.setItem('msrb-ignore-tempban', ignoreTempBan ? '1' : '0')
        }
        try {
            await requestRun({ accounts: emails, ignoreTempBan })
        } catch (e) {
            showToast(e.message, 'error')
        }
    }

    async function requestRun(payload) {
        let body = {}
        if (Array.isArray(payload)) {
            body = { accounts: payload }
        } else if (typeof payload === 'string') {
            body = { account: payload }
        } else if (payload && typeof payload === 'object') {
            if (payload.accounts?.length) body.accounts = payload.accounts
            if (payload.account) body.account = payload.account
            if (payload.ignoreTempBan) body.ignoreTempBan = true
        }

        await api('/api/run', { method: 'POST', body: JSON.stringify(body) })
        const count = body.accounts?.length ?? (body.account ? 1 : 0)
        let toastMsg = count > 1 ? 'Running ' + count + ' accounts' : body.account ? 'Running ' + maskEmail(body.account) : 'Run started'
        if (body.ignoreTempBan) toastMsg += ' (retrying search-limited)'
        showToast(toastMsg, 'success')
        switchTab('console')
        await refreshStatus()
    }

    function readDashClusters() {
        return Math.min(16, Math.max(1, Number($('dash-clusters-control')?.textContent || 3)))
    }

    function setDashClusters(n) {
        const val = Math.min(16, Math.max(1, n))
        if ($('dash-clusters-control')) $('dash-clusters-control').textContent = val
        updateModeBadge(val, $('dash-headless')?.checked)
    }

    async function saveQuickSettings(fromDash) {
        const headless = fromDash ? $('dash-headless').checked : $('quick-headless').checked
        const clusters = fromDash
            ? readDashClusters()
            : clampClusters($('quick-clusters-val')?.textContent || $('quick-clusters')?.value)
        await api('/api/config', {
            method: 'PATCH',
            body: JSON.stringify({
                headless,
                clusters,
                controlPanel: {
                    ...(configCache?.controlPanel || { enabled: true, port: 4780 }),
                    runOnStartup: $('quick-panel-startup')?.checked !== false
                }
            })
        })
        showToast('Settings applied', 'success')
        await loadConfig()
        await refreshStatus()
    }

    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab)
            if (btn.dataset.tab === 'analytics') {
                refreshAnalytics().catch(e => showToast(e.message, 'error'))
            }
        })
    })
    document.querySelectorAll('[data-goto]').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.goto))
    })
    document.querySelectorAll('.settings-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchSettingsPane(btn.dataset.settings))
    })

    $('btn-run')?.addEventListener('click', () => openRunModal())
    $('btn-dash-run')?.addEventListener('click', () => openRunModal())
    $('dash-session-alert-go')?.addEventListener('click', () => switchTab('accounts'))
    $('run-modal-close')?.addEventListener('click', closeRunModal)
    $('run-modal-cancel')?.addEventListener('click', closeRunModal)
    $('run-modal-start')?.addEventListener('click', () => confirmRunModal())
    $('run-modal-search')?.addEventListener('input', paintRunModalList)
    $('run-modal-pending')?.addEventListener('click', () => selectRunModalAccounts('pending'))
    $('run-modal-enabled')?.addEventListener('click', () => selectRunModalAccounts('enabled'))
    $('run-modal-all')?.addEventListener('click', () => selectRunModalAccounts('all'))
    $('run-modal-none')?.addEventListener('click', () => {
        runModalSelected.clear()
        paintRunModalList()
    })
    $('run-modal')?.addEventListener('click', ev => {
        if (ev.target === $('run-modal')) closeRunModal()
    })
    $('btn-stop')?.addEventListener('click', async () => {
        try {
            await api('/api/stop', { method: 'POST' })
            showToast('Stop requested', 'success')
        } catch (e) { showToast(e.message, 'error') }
    })
    $('btn-refresh-runs')?.addEventListener('click', () => refreshRunsToday().catch(e => showToast(e.message, 'error')))
    $('analytics-goal-form')?.addEventListener('submit', e => saveAnalyticsGoal(e).catch(err => showToast(err.message, 'error')))
    $('quick-clusters')?.addEventListener('input', e => setQuickClusters(e.target.value))
    $('btn-quick-save')?.addEventListener('click', () => saveQuickSettings(false).catch(e => showToast(e.message, 'error')))
    $('btn-dash-apply')?.addEventListener('click', () => saveQuickSettings(true).catch(e => showToast(e.message, 'error')))
    $('dash-headless')?.addEventListener('change', e => {
        updateHeadlessLabel(e.target.checked)
        updateModeBadge(readDashClusters(), e.target.checked)
    })
    $('quick-headless')?.addEventListener('change', e => updateHeadlessLabel(e.target.checked, 'quick-headless-label'))
    $('clusters-up')?.addEventListener('click', () => setDashClusters(readDashClusters() + 1))
    $('clusters-down')?.addEventListener('click', () => setDashClusters(readDashClusters() - 1))
    $('settings-clusters-up')?.addEventListener('click', () => setQuickClusters(Number($('quick-clusters-val')?.textContent || 3) + 1))
    $('settings-clusters-down')?.addEventListener('click', () => setQuickClusters(Number($('quick-clusters-val')?.textContent || 3) - 1))
    $('cfg-clusters-up')?.addEventListener('click', () => setCfgClusters(Number($('cfg-clusters')?.value || 3) + 1))
    $('cfg-clusters-down')?.addEventListener('click', () => setCfgClusters(Number($('cfg-clusters')?.value || 3) - 1))
    $('cfg-headless')?.addEventListener('change', e => {
        if ($('quick-headless')) $('quick-headless').checked = e.target.checked
        updateHeadlessLabel(e.target.checked, 'quick-headless-label')
    })

    $('account-search')?.addEventListener('input', paintAccountsTable)
    $('filter-pending')?.addEventListener('change', paintAccountsTable)

    $('btn-enable-all')?.addEventListener('click', async () => {
        for (const a of accountsCache.filter(x => !x.enabled)) {
            await api('/api/accounts/' + encodeURIComponent(a.email), { method: 'PATCH', body: JSON.stringify({ enabled: true }) })
        }
        showToast('All enabled', 'success')
        await refreshAccounts()
        await refreshStatus()
    })

    $('btn-disable-all')?.addEventListener('click', async () => {
        if (!confirm('Disable all accounts?')) return
        for (const a of accountsCache.filter(x => x.enabled)) {
            await api('/api/accounts/' + encodeURIComponent(a.email), { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
        }
        showToast('All disabled', 'success')
        await refreshAccounts()
        await refreshStatus()
    })

    $('btn-workers-all-on')?.addEventListener('click', () => setAllWorkers(true))
    $('btn-workers-all-off')?.addEventListener('click', () => setAllWorkers(false))
    $('btn-save-workers')?.addEventListener('click', async () => {
        try {
            await api('/api/config', { method: 'PATCH', body: JSON.stringify({ workers: collectWorkersPatch() }) })
            showToast('Workers saved', 'success')
            await loadConfig()
        } catch (e) { showToast(e.message, 'error') }
    })

    $('settings-form')?.addEventListener('submit', async ev => {
        ev.preventDefault()
        const logFilter = { enabled: true, mode: 'whitelist', levels: [], keywords: [], regexPatterns: [] }
        document.querySelectorAll('.log-filter').forEach(cb => { if (cb.checked) logFilter.levels.push(cb.dataset.log) })

        try {
            await api('/api/config', {
                method: 'PATCH',
                body: JSON.stringify({
                    headless: $('cfg-headless').checked,
                    clusters: Number($('cfg-clusters').value),
                    searchOnBingLocalQueries: $('cfg-bing-local').checked,
                    scheduler: {
                        enabled: $('cfg-sched-enabled').checked,
                        runOnStartup: $('cfg-sched-startup').checked,
                        timezone: $('cfg-sched-tz').value,
                        startTime: $('cfg-sched-time').value || '08:00'
                    },
                    searchSettings: {
                        searchDelay: { min: secondsToDelaySec($('cfg-search-min').value), max: secondsToDelaySec($('cfg-search-max').value) },
                        readDelay: { min: secondsToDelaySec($('cfg-read-min').value), max: secondsToDelaySec($('cfg-read-max').value) }
                    },
                    consoleLogFilter: logFilter
                })
            })
            showToast('Settings saved', 'success')
            await loadConfig()
            await refreshStatus()
        } catch (e) { showToast(e.message, 'error') }
    })

    $('log-level-filter')?.addEventListener('change', paintLogs)
    $('log-account-filter')?.addEventListener('input', paintLogs)
    $('log-pause')?.addEventListener('change', e => { logPaused = e.target.checked })
    $('btn-clear-logs')?.addEventListener('click', () => { logs.length = 0; paintLogs() })

    document.addEventListener('keydown', e => {
        if (e.target.matches('input, textarea, select')) return
        if (!$('run-modal')?.classList.contains('hidden')) {
            if (e.key === 'Escape') {
                e.preventDefault()
                closeRunModal()
            }
            return
        }
        if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            openRunModal()
        }
    })

    async function init() {
        if (!token) {
            showToast('Open the URL printed at bot startup (includes ?token=…)', 'error')
            return
        }
        try {
            await refreshStatus()
            await refreshRunsToday()
            await refreshAccounts()
            await loadConfig()
            await loadInitialLogs()
            await loadPasswordlessPrompt()
            connectLogStream()
        } catch (e) {
            setConnected(false)
            showToast('Failed to connect: ' + e.message, 'error')
        }
        setInterval(() => refreshStatus().catch(() => setConnected(false)), 4000)
        setInterval(() => {
            refreshRunsToday().catch(() => {})
            if (document.querySelector('#tab-dashboard.active')) {
                refreshAccounts().catch(() => {})
            }
            if (document.querySelector('#tab-analytics.active')) {
                refreshAnalytics().catch(() => {})
            }
        }, 20000)
    }

    init()
})()
