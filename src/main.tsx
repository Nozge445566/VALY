import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { currentLang } from "@/lib/i18n";
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// The page language and title follow the phone (screen readers, browser translate prompts, the tab title).
document.documentElement.lang = currentLang();
document.title = currentLang() === "sv" ? "Valy – Värdera vad som helst, direkt" : "Valy – Value anything, instantly";
