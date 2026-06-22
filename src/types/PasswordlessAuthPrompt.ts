export interface PasswordlessAuthPrompt {
    id: string
    email: string
    number: string | null
    platform: 'desktop' | 'mobile'
    startedAt: string
    timeoutSeconds: number
}

export type PasswordlessAuthPromptInput = Omit<PasswordlessAuthPrompt, 'id' | 'startedAt'>
