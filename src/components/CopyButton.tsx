import { useState } from 'react'
import { IconCheck, IconCopy } from './icons'

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

export function CopyButton({
  text,
  label = 'Copy',
  className = '',
  iconOnly = false,
}: {
  text: string
  label?: string
  className?: string
  iconOnly?: boolean
}) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={copied ? 'Copied' : label}
      onClick={() => {
        void copyText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      {iconOnly ? (copied ? <IconCheck /> : <IconCopy />) : (copied ? 'Copied' : label)}
    </button>
  )
}
