import React from 'react';
const P = {
  check: <path d="M3 8.5l3.2 3.2L13 4.8" />, clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.3l2.2 1.3" /></>,
  mail: <><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="M2.5 4.5L8 9l5.5-4.5" /></>, alert: <><path d="M8 2.2l6 10.6H2z" /><path d="M8 6.5v3M8 11.3v.1" /></>,
  hourglass: <path d="M4 2.5h8M4 13.5h8M5 2.5c0 3 6 4 6 5.5s-6 2.5-6 5.5M11 2.5c0 3-6 4-6 5.5" />, stop: <><circle cx="8" cy="8" r="5.5" /><path d="M5 5l6 6" /></>, dash: <path d="M4 8h8" />,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" /></>,
  moon: <path d="M13 9.5A5.5 5.5 0 116.5 3a4.5 4.5 0 006.5 6.5z" />, refresh: <><path d="M13 8a5 5 0 11-1.6-3.7" /><path d="M13 2.5v3h-3" /></>,
};
export default function Icon({ name, size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{P[name]}</svg>;
}
