import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import { EditorApp } from './editor/EditorApp';
import { buildEditorTheme } from './editor/theme';
import { DEFAULT_ACCENT } from './theme';
import './styles/app.css';
import './styles/editor.css';

declare global {
  interface Window {
    ez: import('../preload/preload').EzApi;
  }
}

function Root() {
  const [accent, setAccent] = useState(DEFAULT_ACCENT);

  useEffect(() => {
    window.ez.appearance().then(({ accent: a, platform }) => {
      setAccent(a);
      document.documentElement.dataset.platform = platform;
    });
    return window.ez.on('appearanceChanged', (a: { accent: string }) => setAccent(a.accent));
  }, []);

  const theme = useMemo(() => buildEditorTheme(accent), [accent]);

  return (
    <FluentProvider theme={theme} applyStylesToPortals style={{ height: '100vh', background: 'transparent' }}>
      <EditorApp />
    </FluentProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
