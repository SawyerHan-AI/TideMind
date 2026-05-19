import { type ReactNode } from 'react';
export type Theme = 'dark' | 'light' | 'system';
interface ThemeContextValue {
    theme: Theme;
    setTheme: (t: Theme) => void;
}
export declare function ThemeProvider({ children }: {
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare function useTheme(): ThemeContextValue;
export {};
