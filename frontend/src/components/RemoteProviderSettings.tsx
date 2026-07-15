import { useEffect, useRef, useState } from 'react'
import {
  providerCredentialDelete,
  providerCredentialSet,
  providerCredentialStatus,
  desktopRuntimeAvailable,
  type RemoteProviderId,
} from '../tauri'
import { useConfirm } from './ConfirmDialog'

const PROVIDERS: ReadonlyArray<{ id: RemoteProviderId; name: string; keyLabel: string }> = [
  { id: 'openai', name: 'OpenAI', keyLabel: 'OpenAI API key' },
  { id: 'anthropic', name: 'Anthropic', keyLabel: 'Anthropic API key' },
  { id: 'gemini', name: 'Google Gemini', keyLabel: 'Gemini API key' },
  { id: 'xai', name: 'xAI', keyLabel: 'xAI API key' },
]

type Phase = 'loading' | 'missing' | 'stored' | 'saving' | 'removing' | 'unavailable' | 'error'

function ProviderCredentialRow({
  provider,
}: {
  provider: (typeof PROVIDERS)[number]
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState('Checking the OS credential vault…')
  const confirm = useConfirm()

  useEffect(() => {
    let active = true
    if (!desktopRuntimeAvailable()) {
      setPhase('unavailable')
      setMessage('Available in the installed app')
      return () => {
        active = false
      }
    }
    providerCredentialStatus(provider.id)
      .then((stored) => {
        if (!active) return
        setPhase(stored ? 'stored' : 'missing')
        setMessage(stored ? 'Key stored in the OS vault' : 'No key stored')
      })
      .catch(() => {
        if (!active) return
        setPhase('error')
        setMessage('Could not read the OS credential vault')
      })
    return () => {
      active = false
    }
  }, [provider.id])

  const saveKey = async () => {
    const input = inputRef.current
    if (!input || !input.value.trim()) {
      setPhase('error')
      setMessage('Paste a key first')
      input?.focus()
      return
    }
    const secret = input.value
    input.value = ''
    setPhase('saving')
    setMessage('Saving to the OS credential vault…')
    try {
      await providerCredentialSet(provider.id, secret)
      setPhase('stored')
      setMessage('Key stored in the OS vault')
    } catch {
      setPhase('error')
      setMessage('Could not store the key in the OS credential vault')
    }
  }

  const removeKey = async () => {
    const approved = await confirm({
      title: `Remove ${provider.name} key?`,
      message: 'This removes the key from your operating system credential vault. It does not affect your provider account.',
      confirmLabel: 'Remove key',
    })
    if (!approved) return
    setPhase('removing')
    setMessage('Removing key…')
    try {
      await providerCredentialDelete(provider.id)
      setPhase('missing')
      setMessage('No key stored')
    } catch {
      setPhase('error')
      setMessage('Could not remove the key from the OS credential vault')
    }
  }

  const busy = phase === 'loading' || phase === 'saving' || phase === 'removing' || phase === 'unavailable'

  return (
    <div className="provider-key-row">
      <div className="provider-key-head">
        <b>{provider.name}</b>
        <span className={`provider-key-status ${phase}`} aria-live="polite">
          {message}
        </span>
      </div>
      <div className="provider-key-actions">
        <input
          ref={inputRef}
          type="password"
          aria-label={provider.keyLabel}
          placeholder={phase === 'stored' ? 'Paste a replacement key' : 'Paste API key'}
          autoComplete="new-password"
          spellCheck={false}
          disabled={busy}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void saveKey()
          }}
        />
        <button type="button" className="btn sm" disabled={busy} onClick={() => void saveKey()}>
          {phase === 'stored' ? 'Replace' : 'Save'}
        </button>
        {phase === 'stored' && (
          <button type="button" className="btn sm ghost danger" disabled={busy} onClick={() => void removeKey()}>
            Remove
          </button>
        )}
      </div>
    </div>
  )
}

export function RemoteProviderSettings() {
  return (
    <details className="sub provider-settings">
      <summary>Optional remote model keys</summary>
      <div className="sub-body">
        <p className="hint provider-settings-intro">
          Local models remain the default. Keys are stored by your operating system—not in Syzygy projects, backups,
          logs, or MCP. Saving a key does not send research anywhere. Every future remote request still requires the
          native <b>Send once</b> confirmation.
        </p>
        {PROVIDERS.map((provider) => (
          <ProviderCredentialRow key={provider.id} provider={provider} />
        ))}
      </div>
    </details>
  )
}
