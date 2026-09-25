'use client'

import { useState, useRef, useEffect } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { Alert, Button, Card } from '@/components/ui'

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
}

export default function AssistantPage() {
  const { me } = useAuth()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend() {
    const text = input.trim()
    if (!text || loading) return

    setInput('')
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setLoading(true)

    try {
      const res = await api.chat({ message: text, conversationId })
      setConversationId(res.conversationId)

      const assistantMsg: ChatMessage = { role: 'assistant', content: res.reply }
      const toolMsgs: ChatMessage[] = (res.toolCalls ?? []).map((tc: any) => ({
        role: 'tool' as const,
        content: `Called ${tc.name} → ${tc.result?.success ? 'success' : tc.result?.error ?? 'error'}`,
        toolName: tc.name,
      }))

      setMessages((prev) => [...prev, ...toolMsgs, assistantMsg])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to get response'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <RequireAuth>
      <AppShell>
        <h1 className="mb-4 text-2xl font-semibold text-cobalt">HR Assistant</h1>
        <p className="mb-6 text-sm text-graphite-soft">
          Ask about leave balances, attendance, company policies, or org structure.
        </p>

        {error && (
          <Alert tone="red">
            {error}
          </Alert>
        )}

        {/* Messages */}
        <div className="mb-4 max-h-[60vh] space-y-3 overflow-y-auto rounded-xl border border-line bg-paper-dim p-4">
          {messages.length === 0 && (
            <p className="py-8 text-center text-sm text-graphite-faint">
              Try: &quot;What&apos;s my leave balance?&quot; or &quot;How many sick days do I have left?&quot;
            </p>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'tool' ? (
                <div className="max-w-[80%] rounded-lg bg-cobalt-tint/40 px-3 py-2 text-xs text-cobalt-ink">
                  <span className="font-medium">Tool:</span> {msg.toolName} — {msg.content}
                </div>
              ) : (
                <div
                  className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
                    msg.role === 'user'
                      ? 'bg-cobalt text-paper'
                      : 'bg-paper border border-line text-ink'
                  }`}
                >
                  {msg.content}
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question..."
            disabled={loading}
            className="flex-1 rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink placeholder:text-graphite-faint focus:border-cobalt focus:outline-none"
          />
          <Button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="bg-cobalt text-paper hover:bg-cobalt-soft rounded-xl px-6"
          >
            {loading ? 'Thinking...' : 'Send'}
          </Button>
        </div>
      </AppShell>
    </RequireAuth>
  )
}
