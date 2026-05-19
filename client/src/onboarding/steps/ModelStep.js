import { jsx as _jsx } from "react/jsx-runtime";
import { useTranslation } from 'react-i18next';
import { StepContainer } from '../components/StepContainer';
import { ModelConnection } from '../../components/settings/ModelConnection';
// 配置检测轮询已上移到 OnboardingProvider，步骤组件只读渲染即可
export function ModelStep() {
    const { t } = useTranslation('onboarding');
    return (_jsx(StepContainer, { title: t('model.title'), description: t('model.description'), skippable: true, skipWarning: t('model.skipWarning'), children: _jsx(ModelConnection, {}) }));
}
