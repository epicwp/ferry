import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { api } from './api';

const SessionContext = createContext('');
export const useEmail = () => useContext(SessionContext);

/** Route wrapper: everything behind it requires a session; 401 → /login. */
export function RequireAuth() {
  const [email, setEmail] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    api.get<{ email: string }>('/api/me')
      .then((me) => setEmail(me.email))
      .catch(() => navigate('/login', { replace: true }));
  }, [navigate]);
  if (email === null) return null;
  return (
    <SessionContext.Provider value={email}>
      <Outlet />
    </SessionContext.Provider>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }}>
      <span className="logo__glyph" />
    </span>
  );
}

export function AppLayout({ title, headerRight, children }: { title: string; headerRight?: ReactNode; children: ReactNode }) {
  const email = useEmail();
  const navigate = useNavigate();
  const initials = email.slice(0, 2).toUpperCase();
  const logout = async () => {
    await api.post('/api/auth/logout');
    navigate('/login');
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand"><Logo /> <span>Ferry</span></div>
        <nav className="sidebar__nav">
          <span className="sidebar__item sidebar__item--active"><span className="sidebar__dot sidebar__dot--accent" />Sites</span>
          <span className="sidebar__item"><span className="sidebar__dot" />Activity</span>
          <span className="sidebar__item"><span className="sidebar__dot" />Settings</span>
          <span className="sidebar__item"><span className="sidebar__dot" />Billing</span>
        </nav>
        <div className="sidebar__account">
          <span className="sidebar__avatar">{initials}</span>
          <span className="sidebar__who">
            <span className="sidebar__email">{email}</span>
            <button className="sidebar__logout" onClick={logout}>Log out</button>
          </span>
        </div>
      </aside>
      <main className="main">
        <header className="main__header">
          <h1>{title}</h1>
          <div>{headerRight}</div>
        </header>
        <div className="main__body">{children}</div>
      </main>
    </div>
  );
}
