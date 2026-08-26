/** Parse OpenAI- and Anthropic-style usage objects for account diagnostics. */
export function diagnosticUsageText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const usage = value as Record<string, unknown>
  const input = Number(usage['prompt_tokens'] ?? usage['input_tokens'])
  const output = Number(usage['completion_tokens'] ?? usage['output_tokens'])
  const parts = [
    Number.isFinite(input) ? `input=${String(input)}` : undefined,
    Number.isFinite(output) ? `output=${String(output)}` : undefined,
  ].filter(part => part !== undefined)
  return parts.length === 0 ? '' : parts.join(', ')
}
