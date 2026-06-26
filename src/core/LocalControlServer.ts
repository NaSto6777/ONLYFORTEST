import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import path from 'path'

import type { DashboardLog } from '../types/Dashboard'
import type { MicrosoftRewardsBot } from '../index'
import { ControlPanelService } from './ControlPanelService'
import { isAgentActive, stopExistingAgent } from './AgentRuntime'

const STATE_DIR = '.core'
const STATE_FILE = 'control-panel.json'

interface ControlPanelState {
    token: string
    port: number
    pid: number
    startedAt: string
}

interface SseClient {
    res: http.ServerResponse
}

function statePath(): string {
    return path.join(process.cwd(), STATE_DIR, STATE_FILE)
}

async function sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
}

async function releaseControlPanelPort(bot: MicrosoftRewardsBot, port: number): Promise<void> {
    if (await isAgentActive()) {
        bot.logger.warn(
            'main',
            'CONTROL-PANEL',
            `Port ${port} in use — stopping previous bot instance…`
        )
        await stopExistingAgent()
        await sleep(750)
    }
}

async function listenOnPort(server: http.Server, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject)
            resolve()
        })
    })
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(Buffer.from(chunk)))
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim()
            if (!raw) {
                resolve({})
                return
            }

            try {
                resolve(JSON.parse(raw))
            } catch (error) {
                reject(error)
            }
        })
        req.on('error', reject)
    })
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
}

function resolvePanelRoot(): string {
    const candidates = [
        path.join(__dirname, '../control-panel'),
        path.join(process.cwd(), 'dist', 'control-panel'),
        path.join(process.cwd(), 'src', 'control-panel')
    ]

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'index.html'))) {
            return candidate
        }
    }

    return candidates[0]!
}

export class LocalControlServer {
    private server: http.Server | null = null
    private token = ''
    private readonly service: ControlPanelService
    private readonly sseClients = new Set<SseClient>()
    private panelRoot = resolvePanelRoot()

    constructor(private readonly bot: MicrosoftRewardsBot) {
        this.service = new ControlPanelService(bot)
    }

    async start(): Promise<{ port: number; token: string; url: string }> {
        if (this.server) {
            return { port: this.bot.config.controlPanel?.port ?? 4780, token: this.token, url: this.buildUrl() }
        }

        this.token = process.env.MSRB_CONTROL_PANEL_TOKEN?.trim() || crypto.randomBytes(24).toString('hex')
        const port = Number(process.env.MSRB_CONTROL_PANEL_PORT ?? this.bot.config.controlPanel?.port ?? 4780)

        await fs.promises.mkdir(path.join(process.cwd(), STATE_DIR), { recursive: true })

        this.server = http.createServer((req, res) => {
            void this.handleRequest(req, res)
        })

        try {
            await listenOnPort(this.server, port)
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code
            if (code === 'EADDRINUSE') {
                await releaseControlPanelPort(this.bot, port)
                try {
                    await listenOnPort(this.server, port)
                } catch (retryError) {
                    const retryCode = (retryError as NodeJS.ErrnoException)?.code
                    if (retryCode === 'EADDRINUSE') {
                        this.server = null
                        throw new Error(
                            `Control panel port ${port} is already in use. Close the other bot window or run: taskkill /F /IM node.exe (then start the bot again).`
                        )
                    }
                    throw retryError
                }
            } else {
                this.server = null
                throw error
            }
        }

        await fs.promises.writeFile(
            statePath(),
            JSON.stringify(
                {
                    token: this.token,
                    port,
                    pid: process.pid,
                    startedAt: new Date().toISOString()
                } satisfies ControlPanelState,
                null,
                2
            )
        )

        const address = this.server.address()
        const boundPort = typeof address === 'object' && address ? address.port : port
        const url = `http://127.0.0.1:${boundPort}/?token=${encodeURIComponent(this.token)}`

        this.bot.logger.info('main', 'CONTROL-PANEL', `Local control panel ready at ${url}`)

        return { port: boundPort, token: this.token, url }
    }

    async stop(): Promise<void> {
        for (const client of this.sseClients) {
            client.res.end()
        }
        this.sseClients.clear()

        if (!this.server) {
            return
        }

        await new Promise<void>(resolve => this.server!.close(() => resolve()))
        this.server = null
        await fs.promises.rm(statePath(), { force: true }).catch(() => undefined)
    }

    publishLog(log: DashboardLog): void {
        const payload = `data: ${JSON.stringify(log)}\n\n`
        for (const client of this.sseClients) {
            client.res.write(payload)
        }
    }

    publishEvent(event: string, payload: unknown): void {
        const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
        for (const client of this.sseClients) {
            client.res.write(data)
        }
    }

    private buildUrl(): string {
        const address = this.server?.address()
        const port = typeof address === 'object' && address ? address.port : this.bot.config.controlPanel?.port ?? 4780
        return `http://127.0.0.1:${port}/?token=${encodeURIComponent(this.token)}`
    }

    private isAuthorized(req: http.IncomingMessage): boolean {
        const header = req.headers.authorization ?? ''
        if (header.startsWith('Bearer ') && header.slice(7) === this.token) {
            return true
        }

        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        return url.searchParams.get('token') === this.token
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const pathname = decodeURIComponent(url.pathname)

            if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
                return this.serveFile(res, path.join(this.panelRoot, 'index.html'), 'text/html; charset=utf-8')
            }

            if (req.method === 'GET' && pathname === '/app.js') {
                return this.serveFile(res, path.join(this.panelRoot, 'app.js'), 'application/javascript; charset=utf-8')
            }

            if (req.method === 'GET' && pathname === '/styles.css') {
                return this.serveFile(res, path.join(this.panelRoot, 'styles.css'), 'text/css; charset=utf-8')
            }

            if (pathname.startsWith('/api/')) {
                if (!this.isAuthorized(req)) {
                    return sendJson(res, 401, { error: 'Unauthorized' })
                }

                if (req.method === 'GET' && pathname === '/api/status') {
                    return sendJson(res, 200, this.service.getStatus())
                }

                if (req.method === 'GET' && pathname === '/api/accounts') {
                    return sendJson(res, 200, { accounts: this.service.getAccounts() })
                }

                if (req.method === 'PATCH' && pathname.startsWith('/api/accounts/')) {
                    const email = pathname.slice('/api/accounts/'.length)
                    const patch = (await readJsonBody(req)) as Record<string, unknown>
                    const account = await this.service.patchAccount(email, patch)
                    return sendJson(res, 200, { account })
                }

                if (req.method === 'DELETE' && pathname.endsWith('/session') && pathname.startsWith('/api/accounts/')) {
                    const email = pathname.slice('/api/accounts/'.length, -'/session'.length)
                    await this.service.clearAccountSession(email)
                    return sendJson(res, 200, { ok: true })
                }

                if (req.method === 'POST' && pathname.endsWith('/open') && pathname.startsWith('/api/accounts/')) {
                    const email = pathname.slice('/api/accounts/'.length, -'/open'.length)
                    try {
                        const body = (await readJsonBody(req)) as { target?: string; platform?: string }
                        const target = body.target === 'bing' ? 'bing' : 'rewards'
                        const platform = body.platform === 'mobile' ? 'mobile' : 'desktop'
                        await this.service.openViewerSession(email, { platform, target })
                        return sendJson(res, 200, { ok: true })
                    } catch (error) {
                        return sendJson(res, 409, {
                            error: error instanceof Error ? error.message : String(error)
                        })
                    }
                }

                if (req.method === 'DELETE' && pathname.endsWith('/open') && pathname.startsWith('/api/accounts/')) {
                    const email = pathname.slice('/api/accounts/'.length, -'/open'.length)
                    try {
                        await this.service.closeViewerSession(email)
                        return sendJson(res, 200, { ok: true })
                    } catch (error) {
                        return sendJson(res, 409, {
                            error: error instanceof Error ? error.message : String(error)
                        })
                    }
                }

                if (req.method === 'GET' && pathname === '/api/config') {
                    return sendJson(res, 200, { config: this.service.getConfigSnapshot() })
                }

                if (req.method === 'PATCH' && pathname === '/api/config') {
                    const patch = (await readJsonBody(req)) as Record<string, unknown>
                    const config = await this.service.patchConfig(patch)
                    return sendJson(res, 200, { config })
                }

                if (req.method === 'POST' && pathname === '/api/run') {
                    try {
                        const body = (await readJsonBody(req)) as {
                            account?: string
                            accounts?: string[]
                            ignoreTempBan?: boolean
                        }
                        const accounts = Array.isArray(body.accounts)
                            ? body.accounts.filter(email => typeof email === 'string' && email.trim())
                            : undefined
                        this.service.requestRun(
                            accounts?.length
                                ? { accounts, ignoreTempBan: body.ignoreTempBan === true }
                                : body.account?.trim()
                                ? { account: body.account.trim(), ignoreTempBan: body.ignoreTempBan === true }
                                : body.ignoreTempBan
                                ? { ignoreTempBan: true }
                                : undefined
                        )
                        return sendJson(res, 200, { ok: true })
                    } catch (error) {
                        return sendJson(res, 409, {
                            error: error instanceof Error ? error.message : String(error)
                        })
                    }
                }

                if (req.method === 'POST' && pathname === '/api/stop') {
                    this.service.requestStop()
                    return sendJson(res, 200, { ok: true })
                }

                if (req.method === 'GET' && pathname === '/api/logs') {
                    return sendJson(res, 200, { logs: this.service.getLogs() })
                }

                if (req.method === 'GET' && pathname === '/api/logs/stream') {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive'
                    })
                    res.write('\n')
                    const client: SseClient = { res }
                    this.sseClients.add(client)
                    if (this.bot.passwordlessPrompt) {
                        res.write(
                            `event: passwordless-prompt\ndata: ${JSON.stringify(this.bot.passwordlessPrompt)}\n\n`
                        )
                    }
                    req.on('close', () => this.sseClients.delete(client))
                    return
                }

                if (req.method === 'GET' && pathname === '/api/passwordless-prompt') {
                    return sendJson(res, 200, { prompt: this.bot.passwordlessPrompt })
                }

                if (req.method === 'GET' && pathname === '/api/runs/today') {
                    return sendJson(res, 200, { runs: this.service.getRunsToday() })
                }

                if (req.method === 'GET' && pathname === '/api/analytics') {
                    return sendJson(res, 200, { analytics: this.service.getAnalytics() })
                }

                if (req.method === 'PATCH' && pathname === '/api/analytics/goal') {
                    const body = (await readJsonBody(req)) as {
                        pointsTarget?: number
                        periodDays?: number
                        label?: string
                    }
                    try {
                        const goal = this.service.setAnalyticsGoal({
                            pointsTarget: Number(body.pointsTarget),
                            periodDays: body.periodDays !== undefined ? Number(body.periodDays) : undefined,
                            label: typeof body.label === 'string' ? body.label : undefined
                        })
                        return sendJson(res, 200, { goal, analytics: this.service.getAnalytics() })
                    } catch (error) {
                        return sendJson(res, 400, {
                            error: error instanceof Error ? error.message : String(error)
                        })
                    }
                }
            }

            sendJson(res, 404, { error: 'Not found' })
        } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
    }

    private serveFile(res: http.ServerResponse, filePath: string, contentType: string): void {
        if (!fs.existsSync(filePath)) {
            sendJson(res, 404, { error: 'File not found' })
            return
        }

        res.writeHead(200, { 'Content-Type': contentType })
        res.end(fs.readFileSync(filePath))
    }
}
