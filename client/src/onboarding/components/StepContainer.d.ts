import { type ReactNode } from 'react';
interface StepContainerProps {
    title: string;
    description?: string;
    children: ReactNode;
    /** 显示跳过按钮（可跳过的步骤） */
    skippable?: boolean;
    /** 跳过时的警告文案 */
    skipWarning?: string;
    /** 隐藏底部导航（欢迎页/完成页自己管理按钮） */
    hideNav?: boolean;
    /** 自定义下一步按钮文案 */
    nextLabel?: string;
    /** 隐藏返回按钮 */
    hideBack?: boolean;
}
export declare function StepContainer({ title, description, children, skippable, skipWarning, hideNav, nextLabel, hideBack, }: StepContainerProps): import("react/jsx-runtime").JSX.Element;
export {};
