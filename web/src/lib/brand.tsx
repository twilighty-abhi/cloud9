// CCD Kochi '26 brand bits for Cloud 9. Owned by lead.
// Wordmark is set in Google Sans Flex (same face as the CCD site); the four symbols mirror CCD's
// think (blue sparkle) · build (green half-circle) · ship (yellow flower) · scale (red asterisk).

export function Sparkle(p: { size?: number; color?: string }) {
  const s = p.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 1.5c.9 5.6 4.2 9 10.5 10.5C16.2 13.4 12.9 16.8 12 22.5 11.1 16.8 7.8 13.4 1.5 12 7.8 10.5 11.1 7.1 12 1.5Z" fill={p.color ?? '#4285F4'} />
    </svg>
  );
}
export function HalfCircle(p: { size?: number; color?: string }) {
  const s = p.size ?? 16; const c = p.color ?? '#34A853';
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke={c} stroke-width="3" />
      <path d="M3 12a9 9 0 0 0 18 0Z" fill={c} />
    </svg>
  );
}
export function Flower(p: { size?: number; color?: string }) {
  const s = p.size ?? 16; const c = p.color ?? '#FAAB00';
  const petals = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return <circle key={i} cx={12 + Math.cos(a) * 6.6} cy={12 + Math.sin(a) * 6.6} r="3.4" fill={c} />;
  });
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
      {petals}
      <circle cx="12" cy="12" r="3.2" fill="#fff" />
    </svg>
  );
}
export function Asterisk(p: { size?: number; color?: string }) {
  const s = p.size ?? 16; const c = p.color ?? '#EA4335';
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
      <g stroke={c} stroke-width="3.2" stroke-linecap="round">
        <path d="M12 2.5v19" /><path d="M2.5 12h19" /><path d="m5.3 5.3 13.4 13.4" /><path d="m18.7 5.3-13.4 13.4" />
      </g>
    </svg>
  );
}

/** Four CCD symbols in a row. */
export function CcdSymbols(p: { size?: number; gap?: number }) {
  const s = p.size ?? 14;
  return (
    <span class="c9-symbols" style={{ gap: `${p.gap ?? Math.round(s / 3)}px` }} aria-hidden="true">
      <Sparkle size={s} /><HalfCircle size={s} /><Flower size={s} /><Asterisk size={s} />
    </span>
  );
}

/** Header brand: stacked "cloud community days 2026" wordmark + divider + "Live Quiz". */
export function Brand(p: { size?: 'md' | 'lg'; app?: string }) {
  return (
    <span class={`c9-brand${p.size === 'lg' ? ' c9-brand--lg' : ''}`}>
      <span class="c9-brand__word" aria-label="Cloud Community Days 2026">
        <span>cloud</span>
        <span>community</span>
        <span>days<b>2026</b><Asterisk size={p.size === 'lg' ? 18 : 9} /></span>
      </span>
      <span class="c9-brand__div" aria-hidden="true" />
      <span class="c9-brand__app">{p.app ?? 'Live Quiz'}</span>
    </span>
  );
}
