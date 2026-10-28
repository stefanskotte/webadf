'use client';

import { useEffect, useId, useState } from 'react';
import { remoteAddUrl } from '@/lib/share/landing';
import { FIELD, FIELD_STYLE, INK_BTN, INK_STYLE } from '@/lib/settings-look';

/**
 * The share link as the visitor holds it, and "Where is your WebFloppy?". The server renders the link without its
 * fragment (a browser never sends `#pin=...`); after hydration it is location.href, pin included.
 */
export function LandingLink({ fallback }: { fallback: string }) {
  const [link, setLink] = useState(fallback);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const addressId = useId();
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the fragment exists only in the browser
  useEffect(() => { setLink(window.location.href); }, []);

  return (
    <div className="flex flex-col gap-5">
      <input readOnly value={link} data-testid="landing-link" aria-label="Share link"
             onFocus={(e) => e.currentTarget.select()} className={`${FIELD} font-mono text-[12px]`} style={FIELD_STYLE} />
      <form className="flex flex-col gap-2" data-testid="landing-form"
            onSubmit={(e) => {
              e.preventDefault();
              const to = remoteAddUrl(address, link);
              if (!to) { setError('Type your WebFloppy’s address, like floppy.example.com or https://192.168.1.20.'); return; }
              window.location.assign(to);
            }}>
        <label htmlFor={addressId} className="text-[14px] font-medium" style={{ color: 'var(--ink)' }}>Where is your WebFloppy?</label>
        <div className="flex flex-wrap gap-2">
          <input id={addressId} data-testid="landing-address" value={address} placeholder="floppy.example.com"
                 inputMode="url" autoComplete="url" onChange={(e) => { setAddress(e.target.value); setError(null); }}
                 className={`${FIELD} min-w-0 flex-1`} style={FIELD_STYLE} />
          <button type="submit" data-testid="landing-go" className={INK_BTN} style={INK_STYLE}>Open</button>
        </div>
        {error && <p role="alert" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</p>}
      </form>
    </div>
  );
}
