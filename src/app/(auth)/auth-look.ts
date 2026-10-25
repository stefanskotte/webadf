// The sign-in / Create account form look (C5 spec §6.3–6.4). Shared by the two forms.
export const AUTH_FORM = 'flex flex-col gap-4';
export const AUTH_H1 = 'text-[34px] font-bold tracking-[-0.01em]';
/** One field: its label, the input, an optional hint -- siblings, so the label names the field and nothing more. */
export const AUTH_FIELD_WRAP = 'flex flex-col gap-1.5';
export const AUTH_LABEL = 'text-[13px] font-medium';
export const AUTH_FIELD =
  'h-[46px] w-full rounded-[12px] border px-3.5 text-[15px] font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
export const AUTH_FIELD_STYLE = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' } as const;
export const AUTH_HINT = 'text-[12px]';
export const AUTH_ERROR = 'rounded-[10px] px-3 py-2.5 text-[13px]';
export const AUTH_ERROR_STYLE = { background: 'var(--danger-bg)', color: 'var(--danger-strong)' } as const;
/** `text-white` keys globals.css' dark-button hover; the inline surface colour wins. aria-disabled, not disabled, so
 *  the clicked button keeps focus while the request runs (spec §6.5). */
export const AUTH_SUBMIT =
  'h-12 rounded-[12px] text-[15px] font-semibold text-white aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
export const AUTH_SUBMIT_STYLE = { background: 'var(--ink)', color: 'var(--surface)' } as const;
