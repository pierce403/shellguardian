import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { followSystemTheme } from './theme';
import './styles.css';

const stopFollowingTheme = followSystemTheme();
window.addEventListener('pagehide', stopFollowingTheme, { once: true });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
