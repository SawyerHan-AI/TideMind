import { type ReactNode } from 'react';
type Timezone = string;
interface TimezoneContextValue {
    timezone: Timezone;
    resolvedTimezone: string;
    setTimezone: (tz: Timezone) => void;
}
export declare function resolveSystemTimezone(): string;
export declare function TimezoneProvider({ children }: {
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare function useTimezone(): TimezoneContextValue;
export {};
