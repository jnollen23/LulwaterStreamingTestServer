import type { ReactNode } from 'react';

function Svg({ children, size = 24 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const PlayIcon = () => <Svg><polygon points="7 4 20 12 7 20 7 4" fill="currentColor" /></Svg>;
export const PauseIcon = () => (
  <Svg><rect x="6" y="4" width="4" height="16" fill="currentColor" /><rect x="14" y="4" width="4" height="16" fill="currentColor" /></Svg>
);
export const PrevIcon = () => <Svg><polygon points="19 20 9 12 19 4 19 20" fill="currentColor" /><line x1="5" y1="19" x2="5" y2="5" /></Svg>;
export const NextIcon = () => <Svg><polygon points="5 4 15 12 5 20 5 4" fill="currentColor" /><line x1="19" y1="5" x2="19" y2="19" /></Svg>;
export const ShuffleIcon = () => (
  <Svg>
    <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
    <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" /><line x1="4" y1="4" x2="9" y2="9" />
  </Svg>
);
export const RepeatIcon = ({ one }: { one?: boolean }) => (
  <Svg>
    <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
    {one && <text x="12" y="15.5" fontSize="9" textAnchor="middle" fill="currentColor" stroke="none">1</text>}
  </Svg>
);
export const BackIcon = () => <Svg><polyline points="15 18 9 12 15 6" /></Svg>;
export const ChevronIcon = ({ up }: { up?: boolean }) => <Svg size={20}><polyline points={up ? '6 15 12 9 18 15' : '6 9 12 15 18 9'} /></Svg>;
export const UserIcon = () => <Svg><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Svg>;
export const LayersIcon = () => (
  <Svg size={20}><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></Svg>
);
export const DotsIcon = () => (
  <Svg><circle cx="12" cy="5" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="19" r="1.6" fill="currentColor" /></Svg>
);
export const ListPlusIcon = () => (
  <Svg><line x1="3" y1="6" x2="15" y2="6" /><line x1="3" y1="12" x2="15" y2="12" /><line x1="3" y1="18" x2="11" y2="18" /><line x1="18" y1="13" x2="18" y2="21" /><line x1="14" y1="17" x2="22" y2="17" /></Svg>
);
export const HomeIcon = () => <Svg><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></Svg>;
export const InfoIcon = () => <Svg><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></Svg>;
export const HeartIcon = ({ filled, size }: { filled?: boolean; size?: number }) => (
  <Svg size={size}><path fill={filled ? 'currentColor' : 'none'} d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></Svg>
);
export const BagIcon = () => (
  <Svg><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 0 1-8 0" /></Svg>
);
export const SearchIcon = () => <Svg size={20}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></Svg>;
export const CloseIcon = () => <Svg><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></Svg>;
export const MusicIcon = ({ size }: { size?: number }) => (
  <Svg size={size}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></Svg>
);
export const FilterIcon = () => <Svg size={20}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></Svg>;
export const SunIcon = () => (
  <Svg size={22}>
    <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </Svg>
);
export const MoonIcon = () => <Svg size={22}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></Svg>;
