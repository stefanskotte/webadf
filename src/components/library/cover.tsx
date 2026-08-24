function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function Cover({ id, title, diskCount }: { id: string; title: string; diskCount: number }) {
  const hue = hueFor(id);
  return (
    <div className="relative overflow-hidden rounded-lg" style={{
      aspectRatio: '1.23 / 1',   // matches the firmware's 138x112 cover box
      background: `linear-gradient(150deg, oklch(0.44 0.16 ${hue}), oklch(0.24 0.10 ${(hue + 45) % 360}))`,
      boxShadow: '0 1px 3px rgb(30 45 60 / 0.22)',
    }}>
      <div className="absolute inset-0" style={{
        background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 3px)',
      }} />
      <div className="absolute inset-0 flex items-end p-3" style={{
        background: 'linear-gradient(to top, rgba(0,0,0,0.70) 0%, rgba(0,0,0,0.12) 48%, transparent 76%)',
      }}>
        <span className="text-sm font-bold leading-tight tracking-[-0.018em] text-white"
              style={{ textShadow: '0 1px 3px rgba(0,0,0,0.55)' }}>{title}</span>
      </div>
      {diskCount > 1 && (
        <div className="absolute right-2 top-2 rounded-full px-2 py-0.5 font-mono text-[9.5px] font-bold"
             style={{ background: 'rgb(255 255 255 / 0.90)', color: '#16273a' }}>
          {diskCount}
        </div>
      )}
    </div>
  );
}
