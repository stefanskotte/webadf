/** The secondary 38 px frame shared by the drive box's buttons (spec §4.4): surface fill, line border, 10 px radius. */
export const BOX_BTN = 'flex min-h-[38px] items-center gap-2 rounded-[10px] border px-3.5 text-[13px] font-medium disabled:opacity-50';
export const BOX_BTN_STYLE = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' } as const;
