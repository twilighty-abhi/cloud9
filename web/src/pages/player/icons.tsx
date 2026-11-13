// Tiny inline icons (Lucide-style: 2px stroke, round caps). Decorative → aria-hidden.
import type { ComponentChildren } from 'preact';

function Svg(props: { size?: number; children: ComponentChildren; class?: string; stroke?: number }) {
  const s = props.size ?? 20;
  return (
    <svg class={props.class} width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width={props.stroke ?? 2} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {props.children}
    </svg>
  );
}

type P = { size?: number; class?: string; stroke?: number };
export const IconCheck = (p: P) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
export const IconX = (p: P) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
export const IconArrowRight = (p: P) => <Svg {...p}><path d="M5 12h14M12 5l7 7-7 7" /></Svg>;
export const IconUsers = (p: P) => <Svg {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></Svg>;
export const IconMinus = (p: P) => <Svg {...p}><path d="M5 12h14" /></Svg>;
export const IconLock = (p: P) => <Svg {...p}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Svg>;
export const IconClock = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Svg>;
export const IconWifiOff = (p: P) => <Svg {...p}><path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76M2 2l20 20" /></Svg>;
export const IconRotate = (p: P) => <Svg {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></Svg>;
