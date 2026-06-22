import crypto from 'crypto'
import { setupDebug } from './setupDebug.js'

const TEMP_MAIL_URL = 'https://temp-mail.org/en/'
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function md5Email(email) {
    return crypto.createHash('md5').update(email.toLowerCase()).digest('hex')
}

function messageBlob(message) {
    if (!message) return ''
    return [
        message.mail_subject,
        message.subject,
        message.mail_from,
        message.from,
        message.mail_text,
        message.mail_text_only,
        message.mail_body,
        message.mail_html,
        message.mail_preview,
        message.bodyPreview,
        message.bodyHtml,
        message.body
    ]
        .filter(Boolean)
        .join('\n')
}

async function tryFetchInboxApi(email) {
    const hash = md5Email(email)
    const url = `https://api.temp-mail.org/request/mail/id/${hash}/format/json/`

    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(12_000) })
        if (!response.ok) return null
        const payload = await response.json()
        if (!payload) return []
        return Array.isArray(payload) ? payload : [payload]
    } catch {
        return null
    }
}

async function readEmailFromPage(page) {
    const selectors = ['#mail', '#email', 'input#mail', '.emailbox-input', '[data-clipboard-text]']

    for (const selector of selectors) {
        const locator = page.locator(selector).first()
        const visible = await locator.isVisible().catch(() => false)
        if (!visible) continue

        const value =
            (await locator.inputValue().catch(() => '')) ||
            (await locator.getAttribute('data-clipboard-text').catch(() => '')) ||
            (await locator.textContent().catch(() => ''))

        const match = String(value).match(EMAIL_PATTERN)
        if (match) return match[0].toLowerCase()
    }

    const bodyText = await page.locator('body').innerText().catch(() => '')
    const match = bodyText.match(EMAIL_PATTERN)
    return match ? match[0].toLowerCase() : null
}

async function refreshTempMailInbox(page) {
    const method = await page
        .evaluate(async () => {
            if (typeof window.refreshMail === 'function') {
                await window.refreshMail()
                return 'refreshMail'
            }

            const button = document.querySelector(
                '[title*="Refresh" i], #refresh-btn, .refresh-inbox, button[aria-label*="Refresh" i]'
            )
            if (button) {
                button.click()
                return 'refresh-button'
            }

            return 'none'
        })
        .catch(() => 'error')

    setupDebug('TEMP-MAIL', `Inbox refresh via ${method}`)
    await sleep(2500)
}

async function fetchInboxMessagesFromBrowser(page) {
    return page
        .evaluate(async () => {
            const messages = []
            const seenIds = new Set()

            const pushMessage = (message, source) => {
                const id = String(message?.mail_id ?? message?._id ?? message?.id ?? '')
                if (id && seenIds.has(id)) return
                if (id) seenIds.add(id)
                messages.push({ ...message, source })
            }

            try {
                const cached = localStorage.getItem('temp_mail_email_cache')
                if (cached) {
                    const list = JSON.parse(cached)
                    if (Array.isArray(list)) {
                        for (const message of list) pushMessage(message, 'cache')
                    }
                }
            } catch {
                /* ignore */
            }

            const sid = localStorage.getItem('guerrilla_session_id')
            if (sid) {
                try {
                    const response = await fetch(
                        `https://api.guerrillamail.com/ajax.php?f=get_email_list&offset=0&sid_token=${encodeURIComponent(sid)}`
                    )
                    if (response.ok) {
                        const data = await response.json()
                        for (const message of data.list || []) pushMessage(message, 'guerrilla')
                    }
                } catch {
                    /* ignore */
                }
            }

            let web2Token = null
            try {
                const sessions = JSON.parse(localStorage.getItem('temp_mail_sessions_v4') || '[]')
                const activeEmail = localStorage.getItem('temp_mail_address')
                const active = sessions.find(session => session.email === activeEmail) || sessions[0]
                web2Token = active?.token || null
            } catch {
                /* ignore */
            }

            if (!web2Token) {
                for (let index = 0; index < localStorage.length; index++) {
                    const key = localStorage.key(index)
                    const value = localStorage.getItem(key)
                    if (!key || !value || value.length < 24) continue
                    if (/token|jwt|auth/i.test(key) && !value.startsWith('[') && !value.startsWith('{')) {
                        web2Token = value
                        break
                    }
                }
            }

            if (web2Token) {
                try {
                    const response = await fetch('https://web2.temp-mail.org/messages', {
                        headers: {
                            accept: 'application/json',
                            authorization: `Bearer ${web2Token}`
                        }
                    })
                    if (response.ok) {
                        const data = await response.json()
                        const list = data.messages || data.list || (Array.isArray(data) ? data : [])
                        for (const message of list) pushMessage(message, 'web2')
                    }
                } catch {
                    /* ignore */
                }
            }

            document.querySelectorAll('a.viewLink[data-mail-id], a[data-mail-id][href*="/en/view/"]').forEach(link => {
                const mailId = link.getAttribute('data-mail-id')
                const subject = (link.textContent || '').replace(/\s+/g, ' ').trim()
                if (!mailId || !subject) return
                pushMessage(
                    {
                        mail_id: mailId,
                        mail_from: 'Microsoft account team',
                        mail_subject: subject,
                        mail_preview: subject,
                        view_href: link.getAttribute('href')
                    },
                    'view-link'
                )
            })

            document.querySelectorAll('#emails tbody tr').forEach(row => {
                if (row.querySelector('.empty-state')) return
                const text = (row.textContent || '').replace(/\s+/g, ' ').trim()
                if (!text || text.length < 8) return
                const idCell = row.querySelector('td')?.textContent?.trim()
                const mailId = idCell && /^\d+$/.test(idCell) ? idCell : null
                pushMessage(
                    {
                        mail_id: mailId,
                        mail_from: text,
                        mail_subject: text,
                        mail_preview: text
                    },
                    'dom-row'
                )
            })

            return messages
        })
        .catch(() => [])
}

async function fetchMessageBodyFromBrowser(page, message) {
    const id = message.mail_id || message._id || message.id
    if (!id) return message

    if (message.view_href || /^[a-f0-9]{20,}$/i.test(String(id))) {
        const viewUrl = message.view_href || `https://temp-mail.org/en/view/${id}`
        setupDebug('TEMP-MAIL', 'Opening email view page', viewUrl)
        await page.goto(viewUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
        await sleep(2000)
        const viewBody = await readEmailViewPageBody(page)
        await returnToTempMailInbox(page)
        if (viewBody) {
            return { mail_body: viewBody, mail_html: viewBody }
        }
    }

    const full = await page
        .evaluate(async mailId => {
            const sid = localStorage.getItem('guerrilla_session_id')
            if (sid) {
                try {
                    const response = await fetch(
                        `https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${encodeURIComponent(mailId)}&sid_token=${encodeURIComponent(sid)}`
                    )
                    if (response.ok) return response.json()
                } catch {
                    /* ignore */
                }
            }

            let web2Token = null
            try {
                const sessions = JSON.parse(localStorage.getItem('temp_mail_sessions_v4') || '[]')
                const activeEmail = localStorage.getItem('temp_mail_address')
                const active = sessions.find(session => session.email === activeEmail) || sessions[0]
                web2Token = active?.token || null
            } catch {
                /* ignore */
            }

            if (!web2Token) {
                for (let index = 0; index < localStorage.length; index++) {
                    const key = localStorage.key(index)
                    const value = localStorage.getItem(key)
                    if (!key || !value || value.length < 24) continue
                    if (/token|jwt|auth/i.test(key) && !value.startsWith('[') && !value.startsWith('{')) {
                        web2Token = value
                        break
                    }
                }
            }

            if (web2Token) {
                try {
                    const response = await fetch(`https://web2.temp-mail.org/messages/${encodeURIComponent(mailId)}`, {
                        headers: {
                            accept: 'application/json',
                            authorization: `Bearer ${web2Token}`
                        }
                    })
                    if (response.ok) return response.json()
                } catch {
                    /* ignore */
                }
            }

            if (typeof window.viewEmail === 'function') {
                await window.viewEmail(mailId)
                await new Promise(resolve => setTimeout(resolve, 1500))
                const modal = document.querySelector('.email-modal')
                if (modal) {
                    return {
                        mail_body: modal.innerText || '',
                        mail_html: modal.innerHTML || ''
                    }
                }
            }

            return null
        }, String(id))
        .catch(() => null)

    return full || message
}

async function scrapeInboxItems(page) {
    const items = []
    const viewLinks = page.locator('a.viewLink[data-mail-id], a[data-mail-id][href*="/en/view/"]')
    const linkCount = await viewLinks.count().catch(() => 0)

    for (let index = 0; index < linkCount; index++) {
        const link = viewLinks.nth(index)
        const text = (await link.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
        if (!text) continue
        items.push({ index, text, link })
    }

    if (items.length) return items

    const rows = page.locator('#emails tbody tr')
    const count = await rows.count().catch(() => 0)

    for (let index = 0; index < count; index++) {
        const row = rows.nth(index)
        const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
        if (!text || text.length < 8) continue
        if (/inbox is empty|waiting for incoming|no verification emails|no starred emails/i.test(text)) continue
        items.push({ index, text, row })
    }

    const cards = page.locator('#emails-responsive .email-card')
    const cardCount = await cards.count().catch(() => 0)
    for (let index = 0; index < cardCount; index++) {
        const card = cards.nth(index)
        const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
        if (!text || text.length < 8) continue
        items.push({ index, text, row: card })
    }

    return items
}

async function readEmailViewPageBody(page) {
    const viewSelectors = [
        '.mail-text',
        '#mail_content',
        '.inbox-data-content',
        '.message-body',
        '.email-view',
        '.mail-inbox',
        'main article',
        'main',
        'article'
    ]

    for (const selector of viewSelectors) {
        const locator = page.locator(selector).first()
        if (await locator.isVisible().catch(() => false)) {
            const text = await locator.innerText().catch(() => '')
            if (text && text.length > 40) return text
            const html = await locator.innerHTML().catch(() => '')
            if (html && html.length > 40) return html
        }
    }

    return page.locator('body').innerText().catch(() => '')
}

async function readOpenedMailBody(page) {
    if (page.url().includes('/en/view/')) {
        return readEmailViewPageBody(page)
    }

    const modal = page.locator('.email-modal').first()
    if (await modal.isVisible().catch(() => false)) {
        const contentSelectors = [
            '.email-modal .mail-body',
            '.email-modal .message-body',
            '.email-modal .modal-body',
            '.email-modal-content',
            '.email-modal'
        ]

        for (const selector of contentSelectors) {
            const locator = page.locator(selector).first()
            if (await locator.isVisible().catch(() => false)) {
                const text = await locator.innerText().catch(() => '')
                if (text && text.length > 20) return text
                const html = await locator.innerHTML().catch(() => '')
                if (html && html.length > 20) return html
            }
        }
    }

    const selectors = [
        '#mail_content',
        '.mail-text',
        '.inbox-data-content',
        '.message-body',
        '.mailview',
        'iframe#mail',
        'article',
        'pre'
    ]

    for (const selector of selectors) {
        const locator = page.locator(selector).first()
        if (await locator.isVisible().catch(() => false)) {
            const text = await locator.innerText().catch(() => '')
            if (text && text.length > 20) return text
        }
    }

    const iframe = page.frameLocator('iframe').first()
    const iframeText = await iframe.locator('body').innerText().catch(() => '')
    if (iframeText && iframeText.length > 20) return iframeText

    return page.locator('body').innerText().catch(() => '')
}

function looksLikeMicrosoftMail(text) {
    return /microsoft|accountprotection|account security|account team|verify your email|security code|outlook|live\.com|@account/i.test(
        text
    )
}

function isMicrosoftVerificationEmail(text) {
    const source = String(text ?? '')
    return (
        /microsoft account team/i.test(source) ||
        /account-security-noreply@accountprotection\.microsoft\.com/i.test(source) ||
        (/accountprotection\.microsoft\.com/i.test(source) && /verify your email address/i.test(source))
    )
}

async function findMicrosoftVerificationViewLink(page) {
    const directLink = page
        .locator('a.viewLink[data-mail-id], a.viewLink.title-subject, a[data-mail-id][href*="/en/view/"]')
        .filter({ hasText: /verify your email address/i })
        .first()

    if (await directLink.isVisible().catch(() => false)) {
        return directLink
    }

    const allLinks = page.locator('a.viewLink[data-mail-id], a[data-mail-id][href*="/en/view/"]')
    const count = await allLinks.count().catch(() => 0)

    for (let index = 0; index < count; index++) {
        const link = allLinks.nth(index)
        const text = (await link.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
        if (/verify your email address/i.test(text)) {
            return link
        }
    }

    return null
}

async function returnToTempMailInbox(page) {
    if (!page.url().includes('/view/')) return
    await page.goto(TEMP_MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    await sleep(1000)
}

async function clickMicrosoftVerificationEmailAndExtractCode(page) {
    await page.bringToFront().catch(() => {})

    const link = await findMicrosoftVerificationViewLink(page)
    if (!link) {
        setupDebug('TEMP-MAIL', 'viewLink "Verify your email address" not in inbox yet')
        return null
    }

    const href = await link.getAttribute('href').catch(() => '')
    const mailId = await link.getAttribute('data-mail-id').catch(() => '')
    setupDebug('TEMP-MAIL', 'Clicking viewLink: Verify your email address', { href, mailId })

    await link.click({ timeout: 10_000 }).catch(() => {})
    await page.waitForURL(/temp-mail\.org\/.*\/view\//, { timeout: 15_000 }).catch(() => {})
    await sleep(2000)

    const body = await readEmailViewPageBody(page)
    const code = extractVerificationCode(body)

    if (code) {
        setupDebug('TEMP-MAIL', 'Security code from Microsoft email view', { code })
        await returnToTempMailInbox(page)
        return code
    }

    setupDebug('TEMP-MAIL', 'Email view opened but security code not parsed', body.slice(0, 250))
    await returnToTempMailInbox(page)
    return null
}

export function extractVerificationCode(text) {
    const source = String(text ?? '').replace(/<[^>]+>/g, ' ')

    const priorityPatterns = [
        /use this security code[:\s]*(\d{4,8})/i,
        /security code[:\s]*(\d{4,8})/i,
        /verification code[:\s]*(\d{4,8})/i,
        /one[- ]time code[:\s]*(\d{4,8})/i,
        /access code[:\s]*(\d{4,8})/i,
        /use this code[:\s]*(\d{4,8})/i,
        /code is[:\s]*(\d{4,8})/i,
        /enter(?: the)? code[:\s]*(\d{4,8})/i,
        /\b(\d{4,8})\b/
    ]

    for (const pattern of priorityPatterns) {
        const match = source.match(pattern)
        if (!match?.[1]) continue
        const code = match[1]
        if (code.length === 4 && (code.startsWith('19') || code.startsWith('20'))) continue
        if (code.length === 6 && (code.startsWith('19') || code.startsWith('20'))) continue
        return code
    }

    const allCodes = [...source.matchAll(/\b(\d{4,8})\b/g)]
        .map(match => match[1])
        .filter(code => code && !(code.length === 6 && (code.startsWith('19') || code.startsWith('20'))))

    return allCodes[0] ?? null
}

async function tryExtractFromVisiblePage(page) {
    const body = await page.locator('body').innerText().catch(() => '')
    if (!body || !/code|microsoft|verify|security/i.test(body)) {
        return null
    }

    const code = extractVerificationCode(body)
    if (code) {
        setupDebug('TEMP-MAIL', 'Verification code found on visible page', { code })
        return code
    }

    return null
}

export async function openTempMailInbox(context) {
    setupDebug('TEMP-MAIL', 'Opening temp-mail.org in a browser tab', TEMP_MAIL_URL)
    const page = await context.newPage()
    await page.goto(TEMP_MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    for (let attempt = 1; attempt <= 20; attempt++) {
        const email = await readEmailFromPage(page)
        if (email) {
            setupDebug('TEMP-MAIL', 'Temporary email ready', email)
            return { page, email }
        }
        setupDebug('TEMP-MAIL', `Waiting for temp-mail.org address (${attempt}/20)`)
        await sleep(1500)
    }

    throw new Error('Could not read a temporary email address from temp-mail.org')
}

export async function pollVerificationEmail({ email, mailPage, seen = new Set() }) {
    const apiMessages = await tryFetchInboxApi(email)
    if (apiMessages?.length) {
        for (const message of apiMessages) {
            const id = message.mail_id || message.mail_unique_id || message.mail_subject
            if (id && seen.has(`api:${id}`)) continue

            const blob = messageBlob(message)
            const code = extractVerificationCode(blob)
            if (code) {
                if (id) seen.add(`api:${id}`)
                setupDebug('TEMP-MAIL', 'Verification code found via legacy API', { code, subject: message.mail_subject })
                return code
            }
        }
    }

    if (!mailPage || mailPage.isClosed()) {
        return null
    }

    await refreshTempMailInbox(mailPage)

    const clickedCode = await clickMicrosoftVerificationEmailAndExtractCode(mailPage)
    if (clickedCode) return clickedCode

    const visibleCode = await tryExtractFromVisiblePage(mailPage)
    if (visibleCode) return visibleCode

    const sessionMessages = await fetchInboxMessagesFromBrowser(mailPage)
    setupDebug('TEMP-MAIL', `Session inbox messages: ${sessionMessages.length}`)

    for (const message of sessionMessages) {
        const id = message.mail_id || message._id || message.id
        const key = id ? `msg:${id}` : `msg:${messageBlob(message).slice(0, 80)}`
        if (seen.has(key)) continue

        const preview = messageBlob(message)
        if (!looksLikeMicrosoftMail(preview)) continue

        setupDebug('TEMP-MAIL', 'Microsoft email candidate', {
            from: message.mail_from || message.from,
            subject: message.mail_subject || message.subject
        })

        let code = extractVerificationCode(preview)
        if (!code) {
            const full = await fetchMessageBodyFromBrowser(mailPage, message)
            code = extractVerificationCode(messageBlob(full))
        }

        if (code) {
            seen.add(key)
            setupDebug('TEMP-MAIL', 'Verification code found via browser session API', { code })
            return code
        }
    }

    const rows = await scrapeInboxItems(mailPage)
    setupDebug('TEMP-MAIL', `Inbox UI rows: ${rows.length}`)
    for (const item of rows) {
        setupDebug('TEMP-MAIL', 'Inbox row preview', item.text.slice(0, 120))
    }

    const hasMicrosoftViewLink = Boolean(await findMicrosoftVerificationViewLink(mailPage))
    if (hasMicrosoftViewLink || rows.some(item => isMicrosoftVerificationEmail(item.text))) {
        const retryCode = await clickMicrosoftVerificationEmailAndExtractCode(mailPage)
        if (retryCode) return retryCode
    }

    return null
}

export async function waitForVerificationEmail({ email, mailPage, timeoutMs = 10 * 60 * 1000 }) {
    const started = Date.now()
    const seen = new Set()

    setupDebug('TEMP-MAIL', 'Waiting for Microsoft verification email', { email, timeoutMs })

    while (Date.now() - started < timeoutMs) {
        const code = await pollVerificationEmail({ email, mailPage, seen })
        if (code) return code
        await sleep(4000)
    }

    return null
}
