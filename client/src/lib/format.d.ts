export declare function timeAgo(isoString: string): string;
export declare function formatDate(isoString: string, timezone: string): string;
/** 短日期格式：MM-DD HH:mm，用于版本历史等空间紧凑的场景 */
export declare function formatShortDate(isoString: string, timezone: string): string;
export declare function formatBytes(bytes: number): string;
export declare function truncate(text: string, max: number): string;
