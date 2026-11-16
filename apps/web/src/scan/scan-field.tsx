import { type FormEvent, type InputHTMLAttributes, useState } from 'react';

/**
 * A scan field: type a code, or let a keyboard-wedge scanner type it, then Enter. Every field
 * that takes a code (the main field, lot, serial, location) is one of these, so a hardware
 * scanner works in all of them (PRD 3.4). It clears after each submit, ready for the next code.
 */
export function ScanField({
  label,
  onSubmit,
  placeholder = 'Scan or type a code',
  button = 'Go',
  autoFocus,
  keepValue = false,
  inputProps,
}: {
  label: string;
  onSubmit: (code: string) => void;
  placeholder?: string;
  button?: string;
  autoFocus?: boolean;
  /** Keep the text after submitting (a lot code being edited). */
  keepValue?: boolean;
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
}) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = value.trim();
    if (!code) return;
    onSubmit(code);
    if (!keepValue) setValue('');
  };
  return (
    <form className="scan-field" onSubmit={submit}>
      <input
        aria-label={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="characters"
        spellCheck={false}
        enterKeyHint="go"
        // biome-ignore lint/a11y/noAutofocus: the scan page exists to take a code right away.
        autoFocus={autoFocus}
        {...inputProps}
      />
      <button type="submit">{button}</button>
    </form>
  );
}
