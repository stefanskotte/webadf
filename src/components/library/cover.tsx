/* eslint-disable @next/next/no-img-element */
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/**
 * A game's box in the library grid.
 *
 * With no stored image this is exactly what it always was -- a deterministic
 * gradient with the title over it. That is not a placeholder for a missing
 * feature: OpenRetro recognises 4 of the operator's 61 disks, so an unadorned
 * card is the ordinary appearance and has to look intentional.
 *
 * With an image, the title overlay comes OFF. The card already prints the
 * title directly underneath, and laying it over real box art hides the part a
 * person is actually scanning for.
 */
export function Cover({
  id, title, diskCount, coverUrl,
}: { id: string; title: string; diskCount: number; coverUrl?: string | null }) {
  const hue = hueFor(id);
  return (
    <div className="relative overflow-hidden rounded-lg" style={{
      aspectRatio: '1.23 / 1',   // matches the firmware's 138x112 cover box
      background: `linear-gradient(150deg, oklch(0.44 0.16 ${hue}), oklch(0.24 0.10 ${(hue + 45) % 360}))`,
      boxShadow: '0 1px 3px rgb(30 45 60 / 0.22)',
    }}>
      {coverUrl ? (
        <>
          {/*
            The same image twice: blurred and overscanned to fill the box,
            then the real one contained on top. Covers are portrait box art
            and screenshots are landscape, so neither `cover` (which would
            crop a cover's logo away) nor `contain` alone (which would leave
            bare gradient down the sides) suits both. The browser fetches one
            URL once, so the second <img> costs no request.
          */}
          <img
            src={coverUrl} alt="" aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover"
            style={{ filter: 'blur(18px) saturate(1.3)', transform: 'scale(1.35)', opacity: 0.55 }}
          />
          <img
            src={coverUrl} alt={`${title} cover`} data-testid="cover-image"
            loading="lazy" decoding="async"
            className="absolute inset-0 h-full w-full object-contain"
          />
        </>
      ) : (
        <>
          <div className="absolute inset-0" style={{
            background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 3px)',
          }} />
          <div className="absolute inset-0 flex items-end p-3" style={{
            background: 'linear-gradient(to top, rgba(0,0,0,0.70) 0%, rgba(0,0,0,0.12) 48%, transparent 76%)',
          }}>
            <span className="text-sm font-bold leading-tight tracking-[-0.018em] text-white"
                  style={{ textShadow: '0 1px 3px rgba(0,0,0,0.55)' }}>{title}</span>
          </div>
        </>
      )}
      {diskCount > 1 && (
        <div className="absolute right-2 top-2 rounded-full px-2 py-0.5 font-mono text-[9.5px] font-bold"
             style={{ background: 'rgb(255 255 255 / 0.90)', color: '#16273a' }}>
          {diskCount}
        </div>
      )}
    </div>
  );
}
