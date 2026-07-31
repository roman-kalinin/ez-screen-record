import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import { App } from './App';
import { buildTheme, DEFAULT_ACCENT } from './theme';
import './styles/app.css';

declare global {
  interface Window {
    ez: import('../preload/preload').EzApi;
  }
}

function Root() {
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [dark, setDark] = useState(true);

  useEffect(() => {
    window.ez.appearance().then(({ accent: a, dark: d }) => {
      setAccent(a);
      setDark(d);
    });
    // Follow the OS when the user changes theme or accent colour.
    return window.ez.on('appearanceChanged', (a: { accent: string; dark: boolean }) => {
      setAccent(a.accent);
      setDark(a.dark);
    });
  }, []);

  const theme = useMemo(() => buildTheme(accent, dark), [accent, dark]);

  return (
    <FluentProvider
      theme={theme}
      // Menus, dropdowns and tooltips render in a portal on document.body,
      // outside this provider. Without this they inherit no theme at all and
      // come out invisible against the Mica backdrop.
      applyStylesToPortals
      style={{ height: '100vh', background: 'transparent' }}
    >
      <App />
    </FluentProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
