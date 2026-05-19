import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './global.css';
import './lib/api';
import { getSavedLanguage, loadLocaleNamespaces } from './lib/i18n';
// perf-optimization-2026-05-17 P1-4:i18n 改按需加载。启动时仅 await 当前
// locale + 英文 fallback 的 16 份 JSON,而不是把 12 语言 × 8 命名空间 = 96
// 份 JSON 全打进首包。其他语言切换时再异步拉对应文件。
const savedLng = getSavedLanguage();
const pending = [loadLocaleNamespaces(savedLng)];
if (savedLng !== 'en')
    pending.push(loadLocaleNamespaces('en'));
Promise.all(pending).finally(() => {
    ReactDOM.createRoot(document.getElementById('root')).render(_jsx(React.StrictMode, { children: _jsx(App, {}) }));
});
