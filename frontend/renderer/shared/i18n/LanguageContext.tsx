import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import en, { TranslationKey } from './en';
import ru from './ru';

export type Language = 'en' | 'ru';

const locales: Record<Language, Record<TranslationKey, string>> = { en, ru };

const STORAGE_KEY = 'progresql-language';

function loadLanguage(): Language {
  if (typeof window === 'undefined') return 'en';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'ru') return stored;
  return 'en';
}

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(loadLanguage);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem(STORAGE_KEY, lang);
  }, []);

  const t = useCallback((key: TranslationKey, params?: Record<string, string | number>): string => {
    let text = locales[language][key] || locales.en[key] || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return text;
  }, [language]);

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
};

export function useTranslation() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useTranslation must be used within LanguageProvider');
  return ctx;
}

/** Safe variant that returns English fallback when LanguageProvider is absent (e.g. in tests). */
export function useTranslationSafe() {
  const ctx = useContext(LanguageContext);
  if (ctx) return ctx;
  // Fallback: always English, no-op setLanguage
  const t = (key: TranslationKey, params?: Record<string, string | number>): string => {
    let text = locales.en[key] || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return text;
  };
  return { language: 'en' as Language, setLanguage: () => {}, t };
}
