import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';
import { initLang } from '@/core/i18n';

// 先读到语言再渲染，避免先闪一下中文
initLang().finally(() =>
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
