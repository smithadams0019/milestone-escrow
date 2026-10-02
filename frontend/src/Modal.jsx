import React, { useEffect, useRef } from 'react';
/** Centered dialog with Escape to cancel and focus placed on the first control. */
export default function Modal({ title, children, onClose, label }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('button, input, select, textarea')?.focus();
    const key = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Tab') { const f = [...ref.current.querySelectorAll('button:not(:disabled), input, select, textarea, a[href]')]; if (!f.length) return; const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); prev?.focus?.(); };
  }, [onClose]);
  return (<div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={label || title} ref={ref}><h2>{title}</h2>{children}</div></div>);
}
