import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { motion, useScroll, useSpring } from 'framer-motion';
import { businessProfile } from '../../data/business';

const navLinks = [
  { label: 'Overview', to: '/' },
  { label: 'Services', to: '/services' },
  { label: 'Products', to: '/products' },
  { label: 'Gallery', to: '/gallery' },
  { label: 'Offers', to: '/offers' },
  { label: 'Social', to: '/social' },
  { label: 'Contact', to: '/contact' },
];

export function SiteHeader() {
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-base/80 backdrop-blur-md">
      <motion.div className="h-[2px] origin-left bg-accent-gradient" style={{ scaleX: progress }} />
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <Link to="/" className="flex items-center gap-2 font-display text-lg font-bold text-ink">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-gradient text-base">RA</span>
          <span className="hidden sm:inline">{businessProfile.identity.name.value}</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {navLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className={({ isActive }) =>
                `rounded-full px-4 py-2 text-sm transition ${
                  isActive ? 'bg-panel2 text-accent2' : 'text-muted hover:text-ink'
                }`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <button
          className="rounded-full border border-line p-2 text-ink md:hidden"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Toggle navigation menu"
          aria-expanded={menuOpen}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
            {menuOpen ? <path d="M6 6l12 12M18 6l-12 12" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </div>

      {menuOpen && (
        <nav className="flex flex-col gap-1 border-t border-line px-5 pb-4 md:hidden">
          {navLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className={({ isActive }) =>
                `rounded-lg px-4 py-3 text-sm ${isActive ? 'bg-panel2 text-accent2' : 'text-muted hover:text-ink'}`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      )}

      <div className="scrollbar-none flex gap-2 overflow-x-auto border-t border-line/70 px-5 py-2 md:hidden">
        {navLinks.map((link) => (
          <NavLink
            key={`tab-${link.to}`}
            to={link.to}
            end={link.to === '/'}
            className={({ isActive }) =>
              `shrink-0 rounded-full border px-3 py-1.5 text-xs ${
                isActive ? 'border-accent/50 bg-accent/10 text-accent2' : 'border-line text-muted'
              }`
            }
          >
            {link.label}
          </NavLink>
        ))}
      </div>
    </header>
  );
}
