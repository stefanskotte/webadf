'use client';

import { useId } from 'react';
import { DISK_BODIES, diskIconMetrics, type DiskColor } from '@/lib/disk-icon';

/**
 * A 3.5" disk, ported from the approved board (ModernDisk.dc.html): body colour, metal shutter, label with the
 * four-colour stripe, set line and title, and optionally a disk behind it (`stack` > 1), the HD hole, a closed
 * write-protect tab (`wp`) and the DF0 badge (`mounted`). Decorative: the root is aria-hidden and the caller
 * labels whatever it sits in. The gradient ids carry a per-instance suffix so two icons on one page do not
 * share a `wfSheen` (an SVG id is document-wide); that is why this is a client component.
 */
export function DiskIcon({
  color = 'black',
  size = 160,
  hd = false,
  wp = false,
  stack = 1,
  mounted = false,
  drive = 'DF0',
  set = '',
  title = '',
  className,
}: {
  color?: DiskColor;
  size?: number;
  hd?: boolean;
  wp?: boolean;
  stack?: number;
  mounted?: boolean;
  /** Which drive the badge names; the drive that actually holds the disk. */
  drive?: 'DF0' | 'DF1';
  set?: string;
  title?: string;
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const sheen = `wfSheen${uid}`;
  const metal = `wfMetal${uid}`;
  const m = diskIconMetrics(size);
  const { body, back } = DISK_BODIES[color] ?? DISK_BODIES.black;
  const backOpacity = stack > 1 ? 1 : 0;
  const hdOpacity = hd ? 1 : 0;
  const hdText = hd ? 0.85 : 0;
  const wpFill = wp ? '#0E0E10' : back;

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        position: 'relative', width: `${m.w}px`, height: `${m.h}px`, fontFamily: 'var(--font-sans)', color: '#24211B',
        filter: `drop-shadow(0 ${m.shadowY}px ${m.shadowBlur}px rgba(36,33,27,0.22))`,
      }}
    >
      <svg width={m.w} height={m.h} viewBox="0 0 106 108" aria-hidden="true"
           style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <defs>
          <linearGradient id={sheen} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.26" />
            <stop offset="0.42" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="1" stopColor="#000000" stopOpacity="0.16" />
          </linearGradient>
          <linearGradient id={metal} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#C9CDD2" />
            <stop offset="0.35" stopColor="#EEF0F2" />
            <stop offset="0.6" stopColor="#C2C6CC" />
            <stop offset="1" stopColor="#DADDE1" />
          </linearGradient>
        </defs>
        <g transform="translate(6 0)" opacity={backOpacity}>
          <path d="M5 0 H88 L100 12 V97 Q100 102 95 102 H5 Q0 102 0 97 V5 Q0 0 5 0 Z" fill={back} />
          <path d="M5 0 H88 L100 12 V97 Q100 102 95 102 H5 Q0 102 0 97 V5 Q0 0 5 0 Z" fill={`url(#${sheen})`} opacity="0.6" />
        </g>
        <g transform="translate(0 6)">
          <path d="M5 0 H88 L100 12 V97 Q100 102 95 102 H5 Q0 102 0 97 V5 Q0 0 5 0 Z" fill={body} />
          <rect x="20" y="0" width="62" height="38" rx="1.5" fill="#000000" opacity="0.18" />
          <rect x="25" y="0" width="52" height="35" rx="1.6" fill={`url(#${metal})`} />
          <rect x="25" y="0" width="52" height="1.2" fill="#ffffff" opacity="0.7" />
          <rect x="58" y="5" width="10" height="25" rx="1.2" fill={body} />
          <rect x="58" y="5" width="10" height="25" rx="1.2" fill="#000000" opacity="0.32" />
          <path d="M11 44 H89 Q91 44 91 46 V102 H9 V46 Q9 44 11 44 Z" fill="#FBF8F1" />
          <path d="M11 44 H89 Q91 44 91 46 V47 H9 V46 Q9 44 11 44 Z" fill="#000000" opacity="0.06" />
          <rect x="3" y="91" width="5" height="6" rx="0.8" fill={wpFill} />
          <rect x="92" y="91" width="5" height="6" rx="0.8" fill="#0E0E10" opacity={hdOpacity} />
          <text x="6" y="13" fontFamily="var(--font-sans)" fontSize="6.5" fontWeight="700" letterSpacing="0.4"
                fill="#ffffff" opacity={hdText}>HD</text>
          <path d="M5 0 H88 L100 12 V97 Q100 102 95 102 H5 Q0 102 0 97 V5 Q0 0 5 0 Z" fill={`url(#${sheen})`} />
          <path d="M5 0.4 H87.8 L99.6 12.2 V97 Q99.6 101.6 95 101.6 H5 Q0.4 101.6 0.4 97 V5 Q0.4 0.4 5 0.4 Z" fill="none"
                stroke="#ffffff" strokeOpacity="0.14" strokeWidth="0.8" />
        </g>
      </svg>
      <div style={{
        position: 'absolute', left: '8.5%', top: '47.5%', width: '77.4%', height: '46%', boxSizing: 'border-box',
        padding: `${m.pad}px`, display: 'flex', flexDirection: 'column', gap: `${m.gap}px`, overflow: 'hidden',
      }}>
        <div aria-hidden="true" style={{ display: 'flex', gap: '2px', height: `${m.stripe}px`, flexShrink: 0 }}>
          <span style={{ flexGrow: 1, background: '#D9453A', borderRadius: '1px' }} />
          <span style={{ flexGrow: 1, background: '#EE8A2A', borderRadius: '1px' }} />
          <span style={{ flexGrow: 1, background: '#4F9D4A', borderRadius: '1px' }} />
          <span style={{ flexGrow: 1, background: '#2F6FB5', borderRadius: '1px' }} />
        </div>
        {m.showText && (
          <>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: `${m.setSize}px`, fontWeight: 500, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: '#8A8172', whiteSpace: 'nowrap', overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>{set}</span>
            <span style={{
              fontFamily: 'var(--font-display)', fontSize: `${m.titleSize}px`, lineHeight: 1.08, fontWeight: 700,
              letterSpacing: '-0.01em', color: '#24211B', display: '-webkit-box', WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{title}</span>
          </>
        )}
      </div>
      {mounted && (
        <span style={{
          position: 'absolute', top: '9%', right: '-4%', display: 'flex', alignItems: 'center', gap: '4px',
          padding: '2px 7px 2px 6px', background: '#14201A', borderRadius: '999px',
          boxShadow: '0 2px 6px rgba(0,0,0,0.3)', fontFamily: 'var(--font-mono)', fontSize: `${m.badgeSize}px`,
          fontWeight: 600, color: '#9BEA9F',
        }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#3FBF55', boxShadow: '0 0 5px #3FBF55' }} />
          {drive}
        </span>
      )}
    </div>
  );
}
